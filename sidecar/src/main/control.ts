import { z } from "zod";
import {
	type BrowserControlBody,
	type BrowserControlValue,
	type BrowserRawStyleInput,
	browserControlAnnotationKindSchema,
	browserControlBodySchema,
	browserControlKeysSchema,
	browserControlMouseButtonSchema,
	browserControlScrollDirectionSchema,
	browserControlString,
	browserRawStyleInputSchema,
} from "./control-records.ts";
import {
	browserWebMCPArgumentsSchema,
	browserWebMCPJSONValueSchema,
} from "./webmcp-records.ts";
// Loopback control server for the Ryu Browser sidecar.
//
// The browser is a standalone Electron app that Core spawns as a `local` manifest
// sidecar (`apps-store/browser/manifest.json`, `SidecarProcess::Local`). It owns
// the user-facing browser chrome and exposes a tiny HTTP control surface bound to
// loopback so Core (and, through Core's ext-proxy, the desktop panel) can
// list/open/navigate tabs, screenshot, take an accessibility snapshot and drive
// synthetic input (click/type/scroll) against it, and — privileged — evaluate JS
// in a tab. Mirrors the island's loopback control server posture
// (`apps/island/src/main/control.ts`) and the mail sidecar's fail-closed bearer
// (`apps-store/mail/backend/src/main.rs`).
//
// SECURITY
// --------
// * Bound to 127.0.0.1 only — no remote origin can reach it.
// * Loopback alone does not stop the user's browser from being used as a
//   confused deputy, so every request is additionally gated by
//   `isTrustedLocalRequest` (no `Origin` header, exact loopback `Host` — kills
//   browser CSRF and DNS rebinding) and body-parsing POST routes require an
//   `application/json` Content-Type (415 otherwise). Same hardening pattern as
//   the island's control server. The one legit browser-context caller — the
//   desktop panel's webview fetch — arrives via Core's ext-proxy, which strips
//   `Origin`/`Referer` before forwarding (see `ext_proxy.rs::copy_headers`),
//   so only a drive-by page talking to this port DIRECTLY still carries one.
// * Every route except `GET /health` requires `Authorization: Bearer <token>`.
//   The token is the SAME per-plugin secret Core injects at spawn (`RYU_EXT_TOKEN`)
//   and re-stamps on every proxied hop; `RYU_BROWSER_TOKEN` is an override for
//   standalone/dev runs. If NEITHER is set the server is FAIL-CLOSED: all
//   protected routes reject (401). This supersedes the task's `RYU_BROWSER_TOKEN`-
//   only wording — validating `RYU_EXT_TOKEN` is what makes the real
//   desktop→Core→ext-proxy→sidecar path authenticate out of the box.
// * `POST /tabs/:id/eval` runs arbitrary JS in a tab's web contents and remains
//   intentionally undocumented as a tool. WebMCP execution is a separate typed
//   route: it can invoke only a tool the page registered in its model context.
//   Both paths are gated by the bearer and the browser control setting.
//
// The request-routing core (`handleRequest`) is a pure async function that takes an
// injected `TabManager`, so it is unit-tested with a fake — no Electron, no sockets.

import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { isIP } from "node:net";
import {
	resolveSidecarPort,
	resolveSidecarToken,
	bearerOk as sharedBearerOk,
} from "@ryu/sidecar-runtime";
import { OPENAPI_DOCUMENT } from "./openapi.ts";
import {
	type BrowserAnnotationInput,
	type BrowserContextRequest,
	type BrowserRect,
	RefError,
	type TabInfo,
	type TabManager,
} from "./tab-manager.ts";
import {
	credentialFieldSchema,
	extractTotpSecret,
	MAX_ACCOUNT_ID_LENGTH,
	TOTP_NOT_FOUND_MESSAGE,
	type VaultClient,
	VaultFillError,
} from "./vault-fill.ts";
import {
	parseWebMCPToolId,
	parseWebMCPToolName,
	serializeWebMCPInput,
	WebMCPError,
} from "./webmcp.ts";

/** Default loopback port. Distinct from Core (:7980), mail (:7996), island (:7989). */
const BROWSER_CONTROL_BASE_PORT = 7993;
/** Maximum request body accepted by the loopback control plane. */
export const MAX_CONTROL_BODY_BYTES = 1024 * 1024;

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"metadata",
	"metadata.google.internal",
	"metadata.goog",
	"host.docker.internal",
]);

function blockedIpv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	const [first, second] = octets;
	return (
		octets.length === 4 &&
		octets.every(
			(part) => Number.isInteger(part) && part >= 0 && part <= 255
		) &&
		(first === 0 ||
			first === 10 ||
			first === 127 ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 169 && second === 254) ||
			(first === 192 && (second === 0 || second === 168)) ||
			(first === 198 && (second === 18 || second === 19)) ||
			(first === 100 && second >= 64 && second <= 127) ||
			first >= 224)
	);
}

export function blockedNavigationAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		return blockedIpv4(address);
	}
	if (family !== 6) {
		return true;
	}
	const normalized = address.toLowerCase();
	const mapped = normalized.match(/^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/);
	const mappedHex = normalized.match(
		/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/
	);
	const mappedHexIpv4 = mappedHex
		? `${Number.parseInt(mappedHex[1] ?? "0", 16) >> 8}.${Number.parseInt(mappedHex[1] ?? "0", 16) & 255}.${Number.parseInt(mappedHex[2] ?? "0", 16) >> 8}.${Number.parseInt(mappedHex[2] ?? "0", 16) & 255}`
		: null;
	return (
		normalized === "::" ||
		normalized === "::1" ||
		(mapped?.[1] ? blockedIpv4(mapped[1]) : false) ||
		(mappedHexIpv4 ? blockedIpv4(mappedHexIpv4) : false) ||
		/^(?:fc|fd)/.test(normalized) ||
		/^fe[89ab]/.test(normalized) ||
		/^(?:fec|fed|fee|fef)/.test(normalized) ||
		normalized.startsWith("64:ff9b::") ||
		normalized.startsWith("2001:db8:")
	);
}

function normalizedNavigationHost(url: URL): string {
	return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function bodyWithinControlLimit(bytes: number): boolean {
	return (
		Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MAX_CONTROL_BODY_BYTES
	);
}

/** Only Core's stamped capability proof may choose a managed Bot lane. */
export function agentLaneForCaller(
	queryAgentId: string | undefined,
	callerAgentId: string | undefined,
	callerUserId?: string | undefined
): string | undefined {
	if (callerAgentId?.trim()) {
		return callerAgentId.trim();
	}
	// A verified human caller may use the visible/user lane, but a bare query is
	// never trusted on the sidecar's direct ext-proxy surface.
	if (callerUserId?.trim()) {
		return undefined;
	}
	if (queryAgentId?.trim()) {
		return undefined;
	}
	return undefined;
}

/**
 * Resolve the bind port. An explicit `RYU_BROWSER_PORT` wins (Core injects the
 * profile-shifted port via the manifest's `port_env`); else the default is shifted
 * by +1000 under `RYU_PROFILE=dev` so a dev browser runs ALONGSIDE a release one
 * without a port clash (mirrors the island's `resolveControlPort`).
 */
export function resolveControlPort(
	env: NodeJS.ProcessEnv = process.env
): number {
	return resolveSidecarPort(env, "RYU_BROWSER_PORT", BROWSER_CONTROL_BASE_PORT);
}

/**
 * Resolve the shared-secret bearer, preferring the generic `RYU_EXT_TOKEN` Core
 * injects and falling back to `RYU_BROWSER_TOKEN` (standalone/dev override). Returns
 * `null` when neither is set — the caller then runs FAIL-CLOSED (rejects protected
 * routes). Empty/whitespace values are treated as unset.
 */
export function resolveControlToken(
	env: NodeJS.ProcessEnv = process.env
): string | null {
	return resolveSidecarToken(env, "RYU_BROWSER_TOKEN");
}

/** Only web documents may be opened through the browser control plane. */
export function safeNavigationUrl(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "about:blank") {
		return trimmed;
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("browser navigation requires a valid web URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			"browser navigation only allows http, https, or about:blank"
		);
	}
	const host = normalizedNavigationHost(parsed);
	if (
		!host ||
		BLOCKED_HOSTNAMES.has(host) ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		(isIP(host) !== 0 && blockedNavigationAddress(host))
	) {
		throw new Error("browser navigation cannot target private or local hosts");
	}
	return trimmed;
}

/** Screen the current DNS answer before Chromium is allowed to navigate. */
export async function safeNavigationUrlResolved(
	value: string
): Promise<string> {
	const safe = safeNavigationUrl(value);
	if (safe === "about:blank") {
		return safe;
	}
	const parsed = new URL(safe);
	const host = normalizedNavigationHost(parsed);
	if (isIP(host)) {
		return safe;
	}
	const addresses = await lookup(host, { all: true, verbatim: true });
	if (
		!addresses.length ||
		addresses.some(({ address }) => blockedNavigationAddress(address))
	) {
		throw new Error("browser navigation cannot target private or local hosts");
	}
	return safe;
}

/** Constant-time bearer check. `null`/empty `expected` ⇒ fail-closed (reject all). */
export function bearerOk(
	authHeader: string | undefined,
	expected: string | null
): boolean {
	return sharedBearerOk(authHeader, expected);
}

/**
 * Guard the loopback server against drive-by browser requests (CSRF) and
 * DNS rebinding. Browsers attach an `Origin` header to every cross-origin
 * request they issue — including CORS-safelisted `text/plain` POSTs that skip
 * preflight, and no-JS `<form enctype="text/plain">` submissions — while the
 * legitimate local callers (Core's ext-proxy reqwest hop, which strips the
 * webview's `Origin` before forwarding; curl in dev) send none. Any non-empty
 * `Origin` is therefore hostile. The `Host` header must also name this exact
 * loopback endpoint: a DNS-rebound page reaches us with
 * `Host: attacker.example`, so anything but our own address:port is rejected.
 * (Mirrors the island's `isTrustedLocalRequest`.)
 */
export function isTrustedLocalRequest(
	req: Pick<IncomingMessage, "headers">,
	port: number
): boolean {
	const origin = req.headers.origin;
	const parsedOrigin = z.string().safeParse(origin);
	if (parsedOrigin.success && parsedOrigin.data.length > 0) {
		return false;
	}
	const host = req.headers.host;
	return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * Whether a declared Content-Type is JSON (tolerating `;charset=` parameters).
 * Body-parsing POST routes 415 without it: browser "simple requests" that dodge
 * CORS preflight cannot send `application/json`. Belt-and-suspenders on top of
 * the Origin check — bodies are only parsed as JSON when they claim to be JSON.
 * (Mirrors the island's `isJsonRequest`.)
 */
export function isJsonContentType(contentType: string | undefined): boolean {
	return (
		(contentType ?? "").split(";")[0]?.trim().toLowerCase() ===
		"application/json"
	);
}

export interface ControlResponse {
	/** JSON body (serialized by the caller). Mutually exclusive with `raw`. */
	json?: unknown;
	/** Pre-serialized body + content type, for non-JSON payloads. */
	raw?: { body: string; contentType: string };
	status: number;
}

const PACKAGE_VERSION = "1.0.0";

function notFound(): ControlResponse {
	return { status: 404, json: { ok: false, error: "not found" } };
}

function badRequest(error: string): ControlResponse {
	return { status: 400, json: { ok: false, error } };
}

function unsupportedMediaType(): ControlResponse {
	return {
		status: 415,
		json: { ok: false, error: "application/json body required" },
	};
}

function tabView(tab: TabInfo) {
	return { id: tab.id, url: tab.url, title: tab.title };
}

/** 404 for "the tab you asked for (or the only tab there could have been) is gone". */
function noSuchTab(explicit: boolean): ControlResponse {
	return {
		status: 404,
		json: {
			ok: false,
			error: explicit
				? "no such tab"
				: "no open tab to act on — open one with POST /tabs first",
		},
	};
}

/** Upper bound on a caller-supplied scroll distance, in CSS pixels. */
const MAX_SCROLL_AMOUNT = 100_000;
const MAX_COORDINATE_COUNT = 8;
const THEME_TOKEN_NAME_RE = /^--[a-zA-Z0-9_-]{1,100}$/;
const THEME_TOKEN_VALUE_UNSAFE_RE = /[{}<>;]/;
const MAX_THEME_TOKEN_COUNT = 128;
const MAX_THEME_TOKEN_VALUE_LENGTH = 16_384;

function parseJsonBody(raw: string): BrowserControlBody | null {
	if (!raw) {
		return {};
	}
	try {
		const parsed = browserControlBodySchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function parseThemeTokens(body: string): Record<string, string> | null {
	const parsed = parseJsonBody(body);
	const parsedTokens = browserControlBodySchema.safeParse(parsed?.tokens);
	if (!parsedTokens.success) {
		return null;
	}
	const entries = Object.entries(parsedTokens.data);
	if (entries.length > MAX_THEME_TOKEN_COUNT) {
		return null;
	}
	const tokens: Record<string, string> = {};
	for (const [name, value] of entries) {
		const parsedValue = z.string().safeParse(value);
		if (
			!(THEME_TOKEN_NAME_RE.test(name) && parsedValue.success) ||
			parsedValue.data.length === 0 ||
			parsedValue.data.length > MAX_THEME_TOKEN_VALUE_LENGTH ||
			THEME_TOKEN_VALUE_UNSAFE_RE.test(parsedValue.data)
		) {
			// Match the shared host bridge: one invalid optional token (for
			// example a page-background URL with CSS punctuation) must not
			// discard the complete appearance snapshot.
			continue;
		}
		tokens[name] = parsedValue.data;
	}
	return tokens;
}

function parseRect(value: BrowserControlValue): BrowserRect | null {
	const parsed = browserControlBodySchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const rect = parsed.data;
	const x = Number(rect.x);
	const y = Number(rect.y);
	const width = Number(rect.width ?? 0);
	const height = Number(rect.height ?? 0);
	if (
		![x, y, width, height].every(Number.isFinite) ||
		width < 0 ||
		height < 0 ||
		width > 100_000 ||
		height > 100_000
	) {
		return null;
	}
	return { height, width, x, y };
}

function parseSelections(value: BrowserControlValue): BrowserRect[] | null {
	if (value === undefined) {
		return [];
	}
	const parsed = z.array(browserWebMCPJSONValueSchema).safeParse(value);
	if (!parsed.success || parsed.data.length > MAX_COORDINATE_COUNT) {
		return null;
	}
	const selections: BrowserRect[] = [];
	for (const item of parsed.data) {
		const rect = parseRect(item);
		if (!rect) {
			return null;
		}
		selections.push(rect);
	}
	return selections;
}

function parseStyle(
	value: BrowserControlValue
): BrowserRawStyleInput | undefined {
	const parsed = browserRawStyleInputSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

export interface RequestDeps {
	controlEnabled?: () => boolean;
	setTheme?: (tokens: Record<string, string>) => void;
	tabs: TabManager;
	/** A managed Bot's own tab lane; may resolve once its isolated session is ready. */
	tabsFor?: (agentId: string) => TabManager | null | Promise<TabManager | null>;
	token: string | null;
	validateNavigationUrl?: (value: string) => Promise<string> | string;
	/** Core's `vault.*` kernel capabilities; null/absent outside Core (503). */
	vault?: VaultClient | null;
}

/** Who is asking for an agent-account credential, and how to reach the vault. */
interface CredentialContext {
	/** Core-verified calling agent (the stamped lane), or undefined for the user lane. */
	agentId: string | undefined;
	vault: VaultClient | null;
}

async function runClick(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const ref = (browserControlString(parsed.ref) ?? "").trim();
	if (ref === "") {
		return badRequest("missing ref");
	}
	const result = await tabs.click(tabId, ref);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

async function runType(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const ref = (browserControlString(parsed.ref) ?? "").trim();
	if (ref === "") {
		return badRequest("missing ref");
	}
	const text = browserControlString(parsed.text);
	if (text === undefined) {
		return badRequest("missing text");
	}
	const result = await tabs.type(
		tabId,
		ref,
		text,
		parsed.submit === true,
		parsed.replace === true
	);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

function vaultUnavailable(): ControlResponse {
	return {
		status: 503,
		json: {
			ok: false,
			error:
				"agent accounts need the Ryu vault, and this browser was not started by Ryu Core",
		},
	};
}

function parseAccountId(parsed: BrowserControlBody): string | null {
	const account = (browserControlString(parsed.account) ?? "").trim();
	return account && account.length <= MAX_ACCOUNT_ID_LENGTH ? account : null;
}

/**
 * Fill an agent-account credential. The response deliberately carries no value:
 * the secret goes from Core to the page's editing pipeline and nowhere else.
 */
async function runFillCredential(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody,
	{ agentId, vault }: CredentialContext
): Promise<ControlResponse> {
	const ref = (browserControlString(parsed.ref) ?? "").trim();
	if (ref === "") {
		return badRequest("missing ref");
	}
	const account = parseAccountId(parsed);
	if (!account) {
		return badRequest(
			"missing account: pass the id from chromium.create_account or chromium.list_accounts"
		);
	}
	const field = credentialFieldSchema.safeParse(parsed.field);
	if (!field.success) {
		return badRequest("field must be one of username, email, password, totp");
	}
	if (!vault) {
		return vaultUnavailable();
	}
	const result = await tabs.fillCredential(
		tabId,
		ref,
		field.data,
		(pageUrl) =>
			vault.credentialFill({
				account,
				agent_id: agentId ?? null,
				field: field.data,
				page_url: pageUrl,
			}),
		parsed.submit === true
	);
	return result === null
		? noSuchTab(true)
		: {
				status: 200,
				json: {
					ok: true,
					tab: tabView(result.tab),
					account,
					field: field.data,
					filled: true,
				},
			};
}

/**
 * Read a 2FA setup QR code or text key from the page and enroll it in the vault.
 * The secret is never returned, so the agent can only USE it via
 * `/fill-credential` with field `totp`.
 */
async function runCaptureTotp(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody,
	{ agentId, vault }: CredentialContext
): Promise<ControlResponse> {
	const ref = (browserControlString(parsed.ref) ?? "").trim();
	if (ref === "") {
		return badRequest("missing ref");
	}
	const account = parseAccountId(parsed);
	if (!account) {
		return badRequest(
			"missing account: pass the id from chromium.create_account or chromium.list_accounts"
		);
	}
	if (!vault) {
		return vaultUnavailable();
	}
	const source = await tabs.readTotpSetup(tabId, ref);
	if (source === null) {
		return noSuchTab(true);
	}
	if (source.in_frame) {
		return badRequest(
			"the setup key is inside an iframe; only the page's top-level document can enroll a TOTP secret"
		);
	}
	const secret = extractTotpSecret(source.candidates);
	if (!secret) {
		return badRequest(TOTP_NOT_FOUND_MESSAGE);
	}
	await vault.totpEnroll({
		account,
		agent_id: agentId ?? null,
		page_url: source.tab.url,
		secret,
	});
	return {
		status: 200,
		json: { ok: true, tab: tabView(source.tab), account, enrolled: true },
	};
}

async function runScroll(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const direction = browserControlScrollDirectionSchema.safeParse(
		parsed.direction
	);
	if (!direction.success) {
		return badRequest("direction must be one of up, down, left, right");
	}
	let amount: number | undefined;
	if (parsed.amount !== undefined && parsed.amount !== null) {
		const raw = Number(parsed.amount);
		if (!Number.isFinite(raw) || raw <= 0) {
			return badRequest("amount must be a positive number of pixels");
		}
		// The canonical `browser.scroll.amount` is an unbounded integer, so an
		// enormous value is a LEGAL request the schema promised. Clamping to what a
		// wheel event can usefully travel keeps that promise; refusing it would make
		// the sidecar narrower than the verb it serves.
		amount = Math.min(raw, MAX_SCROLL_AMOUNT);
	}
	const result = await tabs.scroll(tabId, direction.data, amount);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

async function runContext(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const selections = parseSelections(parsed.selections);
	if (!selections) {
		return badRequest("selections must be an array of valid rectangles");
	}
	const result = await tabs.context(tabId, {
		include_screenshot: parsed.include_screenshot !== false,
		selections,
	} satisfies BrowserContextRequest);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

async function runWebMCPExecute(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	let name: string;
	try {
		name = parseWebMCPToolName(parsed.tool_name);
	} catch (error) {
		return {
			status: error instanceof WebMCPError ? error.status : 400,
			json: {
				error: error instanceof Error ? error.message : "invalid tool_name",
				ok: false,
			},
		};
	}
	let toolId: string | undefined;
	if (parsed.tool_id !== undefined) {
		try {
			toolId = parseWebMCPToolId(parsed.tool_id);
		} catch (error) {
			return {
				status: error instanceof WebMCPError ? error.status : 400,
				json: {
					error: error instanceof Error ? error.message : "invalid tool_id",
					ok: false,
				},
			};
		}
	}
	const parsedInput = browserWebMCPArgumentsSchema.safeParse(
		parsed.arguments === undefined ? {} : parsed.arguments
	);
	const input = parsedInput.success ? parsedInput.data : null;
	if (!input) {
		return badRequest("arguments must be a JSON object");
	}
	try {
		serializeWebMCPInput(input);
	} catch (error) {
		return {
			status: error instanceof WebMCPError ? error.status : 400,
			json: {
				error: error instanceof Error ? error.message : "invalid arguments",
				ok: false,
			},
		};
	}
	try {
		const execution = await tabs.webmcpExecute(tabId, name, input, toolId);
		if (!execution) {
			return noSuchTab(true);
		}
		return {
			status: 200,
			json: {
				origin: execution.tool.origin,
				result: execution.result,
				tool_name: execution.tool.name,
				tool_id: execution.tool.tool_id,
				consequential_hint: execution.tool.annotations.consequentialHint,
				debugging_hint: execution.tool.annotations.debugging,
				untrusted_content: true,
				untrusted_content_hint:
					execution.tool.annotations.untrustedContentHint === true,
			},
		};
	} catch (error) {
		return {
			status: error instanceof WebMCPError ? error.status : 500,
			json: {
				error:
					error instanceof Error ? error.message : "WebMCP execution failed",
				ok: false,
			},
		};
	}
}

async function runAnnotation(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const kind = browserControlAnnotationKindSchema.safeParse(parsed.kind);
	if (!kind.success) {
		return badRequest("kind must be area, element, or elements");
	}
	const comment = (browserControlString(parsed.comment) ?? "").trim();
	if (!comment) {
		return badRequest("missing comment");
	}
	const rect = parseRect(parsed.rect);
	if (!rect) {
		return badRequest("rect must contain finite x, y, width, and height");
	}
	const selections = parseSelections(parsed.selections);
	if (selections === null) {
		return badRequest("selections must be an array of valid rectangles");
	}
	const result = await tabs.annotate(tabId, {
		comment,
		kind: kind.data,
		rect,
		selections: selections.length > 0 ? selections : [rect],
		style: parseStyle(parsed.style),
	} satisfies BrowserAnnotationInput);
	return result === null ? noSuchTab(true) : { status: 201, json: result };
}

async function runHover(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const ref = (browserControlString(parsed.ref) ?? "").trim();
	if (!ref) {
		return badRequest("missing ref");
	}
	const result = await tabs.hover(tabId, ref);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

function parsePoint(
	value: BrowserControlValue
): { x: number; y: number } | null {
	const parsed = browserControlBodySchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const point = parsed.data;
	const x = Number(point.x);
	const y = Number(point.y);
	return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

async function runClickAt(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const x = Number(parsed.x);
	const y = Number(parsed.y);
	const button = browserControlMouseButtonSchema.safeParse(
		parsed.button === undefined ? "left" : parsed.button
	);
	const count = parsed.count === undefined ? 1 : Number(parsed.count);
	if (
		!(
			Number.isFinite(x) &&
			Number.isFinite(y) &&
			button.success &&
			Number.isInteger(count)
		) ||
		count < 1 ||
		count > 3
	) {
		return badRequest("x/y, button, or count is invalid");
	}
	const result = await tabs.clickAt(tabId, x, y, button.data, count);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

async function runKey(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const keys = browserControlKeysSchema.safeParse(parsed.keys);
	if (!keys.success) {
		return badRequest("keys must be a non-empty array of key names");
	}
	const result = await tabs.key(tabId, keys.data);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

async function runDrag(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const from = parsePoint(parsed.from);
	const to = parsePoint(parsed.to);
	if (!(from && to)) {
		return badRequest("from and to must contain finite x and y coordinates");
	}
	const result = await tabs.drag(tabId, from, to);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

/**
 * The three synthetic-input routes (`/click`, `/type`, `/scroll`).
 *
 * They are FLAT rather than `/tabs/:id/…` on purpose: the canonical verbs
 * (`browser.click` / `browser.type` / `browser.scroll`) make `tab_id` OPTIONAL —
 * "omit for the active tab" — and a declarative http tool interpolates a path
 * parameter unconditionally, so a `/tabs/{id}/click` route would hard-fail the whole
 * call the moment a model exercised that documented option. Carrying the tab in the
 * body lets the omission mean what the schema says it means. `snapshot` keeps the
 * path shape because ITS canonical `tab_id` is required.
 *
 * `/fill-credential` and `/capture-totp` (agent accounts, `vault-fill.ts`) ride
 * the same flat shape. They take the calling agent from Core's stamped lane
 * header, never from the request, and never echo a secret.
 */
async function handleControlAction(
	method: string,
	path: string,
	parsed: BrowserControlBody,
	tabs: TabManager,
	credential: CredentialContext = { agentId: undefined, vault: null }
): Promise<ControlResponse> {
	if (method !== "POST") {
		return notFound();
	}
	const raw = browserControlString(parsed.tab_id);
	const explicit = raw !== undefined && raw.trim() !== "";
	const tabId = explicit ? raw.trim() : tabs.activeId();
	if (tabId === null || !tabs.list().some((t) => t.id === tabId)) {
		return noSuchTab(explicit);
	}
	try {
		if (path === "/click") {
			return await runClick(tabs, tabId, parsed);
		}
		if (path === "/type") {
			return await runType(tabs, tabId, parsed);
		}
		if (path === "/scroll") {
			return await runScroll(tabs, tabId, parsed);
		}
		if (path === "/hover") {
			return await runHover(tabs, tabId, parsed);
		}
		if (path === "/click-at") {
			return await runClickAt(tabs, tabId, parsed);
		}
		if (path === "/key") {
			return await runKey(tabs, tabId, parsed);
		}
		if (path === "/fill-credential") {
			return await runFillCredential(tabs, tabId, parsed, credential);
		}
		if (path === "/capture-totp") {
			return await runCaptureTotp(tabs, tabId, parsed, credential);
		}
		return await runDrag(tabs, tabId, parsed);
	} catch (e) {
		// Core's vault refusal (wrong host, another agent's account, no TOTP
		// enrolled, missing grant) is surfaced verbatim; it never carries a secret.
		if (e instanceof VaultFillError) {
			return { status: e.status, json: { ok: false, error: e.message } };
		}
		// A stale/unknown element ref is the CALLER's to fix (re-run snapshot), so it
		// is a 400 carrying that instruction — never a blind 500, and never a silent
		// fallback to some other element.
		if (e instanceof RefError) {
			return { status: 400, json: { ok: false, error: e.message } };
		}
		return {
			status: 500,
			json: {
				ok: false,
				error: e instanceof Error ? e.message : "browser control failed",
			},
		};
	}
}

/**
 * Dispatch the generic `browser.control` capability envelope.
 *
 * Core's capability broker forwards the body to the provider's declared `/`
 * route. Keeping this adapter here lets the browser remain a standalone
 * sidecar: the broker does not need provider-specific routes or clients, and
 * the adapter exposes only the finite browser verbs (never arbitrary eval).
 */
async function handleCapabilityBridge(
	body: string,
	tabs: TabManager,
	validateNavigationUrl: (value: string) => Promise<string> | string
): Promise<ControlResponse> {
	const envelope = parseJsonBody(body);
	if (!envelope) {
		return badRequest("invalid json body");
	}
	const tool = (browserControlString(envelope.tool) ?? "").trim();
	const parsedArgs = browserControlBodySchema.safeParse(envelope.args);
	const args = parsedArgs.success ? parsedArgs.data : {};

	if (tool === "browser.tabs") {
		return { status: 200, json: { tabs: tabs.list().map(tabView) } };
	}

	if (tool === "browser.navigate") {
		const url = (browserControlString(args.url) ?? "").trim();
		if (url === "") {
			return badRequest("missing url");
		}
		let safeUrl: string;
		try {
			safeUrl = await validateNavigationUrl(url);
		} catch (error) {
			return badRequest(error instanceof Error ? error.message : "invalid url");
		}
		const tab = tabs.open(safeUrl);
		return { status: 201, json: { tab: tabView(tab) } };
	}

	const tabId = (browserControlString(args.tab_id) ?? "").trim();
	if (tool === "browser.navigate_tab") {
		if (tabId === "") {
			return badRequest("missing tab_id");
		}
		const url = (browserControlString(args.url) ?? "").trim();
		if (url === "") {
			return badRequest("missing url");
		}
		let safeUrl: string;
		try {
			safeUrl = await validateNavigationUrl(url);
		} catch (error) {
			return badRequest(error instanceof Error ? error.message : "invalid url");
		}
		const tab = tabs.navigate(tabId, safeUrl);
		return tab ? { status: 200, json: { tab: tabView(tab) } } : notFound();
	}

	if (tool === "browser.close_tab") {
		if (tabId === "") {
			return badRequest("missing tab_id");
		}
		return tabs.close(tabId) ? { status: 200, json: { ok: true } } : notFound();
	}

	if (
		tool === "browser.context" ||
		tool === "browser.annotate" ||
		tool === "browser.clear_annotations"
	) {
		if (tabId === "") {
			return badRequest("missing tab_id");
		}
		try {
			if (tool === "browser.context") {
				return await runContext(tabs, tabId, args);
			}
			if (tool === "browser.annotate") {
				return await runAnnotation(tabs, tabId, args);
			}
			const cleared = tabs.clearAnnotations(tabId);
			return cleared === null
				? notFound()
				: { status: 200, json: { ok: true, cleared } };
		} catch (error) {
			return error instanceof RefError
				? { status: 400, json: { ok: false, error: error.message } }
				: {
						status: 500,
						json: {
							ok: false,
							error:
								error instanceof Error
									? error.message
									: "browser control failed",
						},
					};
		}
	}

	if (tool === "browser.snapshot" || tool === "browser.screenshot") {
		if (tabId === "") {
			return badRequest("missing tab_id");
		}
		try {
			if (tool === "browser.snapshot") {
				const snapshot = await tabs.snapshot(tabId);
				return snapshot === null ? notFound() : { status: 200, json: snapshot };
			}
			const png = await tabs.screenshot(tabId);
			return png === null
				? notFound()
				: {
						status: 200,
						json: { image: png, encoding: "base64", mime: "image/png" },
					};
		} catch (error) {
			return {
				status: 500,
				json: {
					ok: false,
					error:
						error instanceof Error ? error.message : "browser control failed",
				},
			};
		}
	}

	if (
		tool === "browser.click" ||
		tool === "browser.type" ||
		tool === "browser.scroll" ||
		tool === "browser.hover" ||
		tool === "browser.click_at" ||
		tool === "browser.key" ||
		tool === "browser.drag"
	) {
		const path =
			tool === "browser.click"
				? "/click"
				: tool === "browser.type"
					? "/type"
					: tool === "browser.scroll"
						? "/scroll"
						: tool === "browser.hover"
							? "/hover"
							: tool === "browser.click_at"
								? "/click-at"
								: tool === "browser.key"
									? "/key"
									: "/drag";
		return handleControlAction("POST", path, args, tabs);
	}

	return badRequest(`unsupported browser capability '${tool || ""}'`);
}

/**
 * Pure request router. `path` is the URL path (no query string), `method` the HTTP
 * verb, `authHeader` the raw `Authorization` value, `body` the raw request body,
 * `contentType` the raw `Content-Type` value (body-parsing POST routes 415 unless
 * it declares `application/json`; the body-less `POST /tabs/:id/screenshot` is
 * exempt — nothing is parsed there, and its callers send no body to declare).
 * Every route except `GET /health` is bearer-gated. Async because screenshot/eval
 * touch the web contents.
 */
export async function handleRequest(
	method: string,
	path: string,
	authHeader: string | undefined,
	body: string,
	{
		controlEnabled,
		setTheme,
		tabs: defaultTabs,
		tabsFor,
		token,
		validateNavigationUrl = safeNavigationUrl,
		vault,
	}: RequestDeps,
	contentType?: string,
	agentId?: string
): Promise<ControlResponse> {
	// Liveness — unauthenticated, reveals only version + tab count.
	if (method === "GET" && path === "/health") {
		return {
			status: 200,
			json: {
				ok: true,
				name: "ryu-browser",
				version: PACKAGE_VERSION,
				tabs: defaultTabs.list().length,
			},
		};
	}
	// Everything below is protected.
	if (!bearerOk(authHeader, token)) {
		return { status: 401, json: { ok: false, error: "unauthorized" } };
	}
	// Appearance is a host-owned concern, not browser control. Keep this route
	// available when the user has disabled agent control so the shell can still
	// follow the Desktop appearance they selected.
	if (method === "PUT" && path === "/theme") {
		if (!isJsonContentType(contentType)) {
			return unsupportedMediaType();
		}
		const tokens = parseThemeTokens(body);
		if (!tokens) {
			return badRequest(
				"theme tokens must be a bounded CSS custom-property map"
			);
		}
		setTheme?.(tokens);
		return { status: 200, json: { ok: true } };
	}
	if (controlEnabled && !controlEnabled()) {
		return {
			status: 403,
			json: {
				error: "browser control is disabled in Browser settings",
				ok: false,
			},
		};
	}
	// Resolve a managed Bot's hidden tab lane only after authentication and the
	// user-controlled Browser capability gate. This prevents unauthenticated
	// requests from lazily creating windows or Chromium state.
	const tabs =
		agentId === undefined ? defaultTabs : ((await tabsFor?.(agentId)) ?? null);
	if (!tabs) {
		return {
			status: 403,
			json: {
				ok: false,
				error: "browser session is not available for this Bot",
			},
		};
	}

	// Capability root (`browser.control` provides `route: "/"`). Small info payload
	// so the broker call resolves to a real handler rather than a 404.
	if (method === "GET" && path === "/") {
		return {
			status: 200,
			json: {
				ok: true,
				name: "ryu-browser",
				version: PACKAGE_VERSION,
				capability: "browser.control",
			},
		};
	}

	// Core's generic capability broker POSTs `{tool,args}` to the provider's
	// declared route (`/`). Keep this finite and explicit; in particular, do not
	// add a browser.eval or dynamic WebMCP escape hatch here — those are separate,
	// typed routes with their own schemas.
	if (method === "POST" && path === "/") {
		if (!isJsonContentType(contentType)) {
			return unsupportedMediaType();
		}
		return handleCapabilityBridge(body, tabs, validateNavigationUrl);
	}

	// The app's own OpenAPI document. Core fetches this on the sidecar's first
	// Healthy edge to derive agent tools from it — `openapi.ts` explains why it
	// describes only the service/liveness routes and not the tab surface. Behind the
	// bearer like every route but `/health`: Core's importer authenticates
	// (`import_openapi` sends the same minted `ext_token`), so gating costs nothing,
	// and this loopback port is reachable by every process on the machine.
	if (method === "GET" && path === "/openapi.json") {
		return { status: 200, json: OPENAPI_DOCUMENT };
	}

	if (path === "/tabs") {
		if (method === "GET") {
			return { status: 200, json: { tabs: tabs.list().map(tabView) } };
		}
		if (method === "POST") {
			if (!isJsonContentType(contentType)) {
				return unsupportedMediaType();
			}
			const parsed = parseJsonBody(body);
			if (!parsed) {
				return badRequest("invalid json body");
			}
			const url = browserControlString(parsed.url) ?? "about:blank";
			let safeUrl: string;
			try {
				safeUrl = await validateNavigationUrl(url);
			} catch (error) {
				return badRequest(
					error instanceof Error ? error.message : "invalid url"
				);
			}
			const tab = tabs.open(safeUrl);
			return { status: 201, json: { tab: tabView(tab) } };
		}
		return notFound();
	}

	// Synthetic input. Body-parsing, so JSON is required like /navigate.
	if (
		path === "/click" ||
		path === "/type" ||
		path === "/scroll" ||
		path === "/hover" ||
		path === "/click-at" ||
		path === "/key" ||
		path === "/drag" ||
		path === "/fill-credential" ||
		path === "/capture-totp"
	) {
		if (method !== "POST") {
			return notFound();
		}
		if (!isJsonContentType(contentType)) {
			return unsupportedMediaType();
		}
		const parsed = parseJsonBody(body);
		if (!parsed) {
			return badRequest("invalid json body");
		}
		return await handleControlAction(method, path, parsed, tabs, {
			agentId,
			vault: vault ?? null,
		});
	}

	// Annotations use a nested route because they belong to one concrete page. The
	// live context itself is POSTed so a caller can optionally point at one or more
	// viewport rectangles while still retrieving the current frozen-frame state.
	const annotationMatch = path.match(
		/^\/tabs\/([^/]+)\/annotations(?:\/([^/]+))?$/
	);
	if (annotationMatch) {
		const id = decodeURIComponent(annotationMatch[1]);
		const annotationId = annotationMatch[2]
			? decodeURIComponent(annotationMatch[2])
			: undefined;
		if (method === "DELETE") {
			const cleared = tabs.clearAnnotations(id, annotationId);
			return cleared === null
				? notFound()
				: { status: 200, json: { ok: true, cleared } };
		}
		if (method === "POST" && annotationId === undefined) {
			if (!isJsonContentType(contentType)) {
				return unsupportedMediaType();
			}
			const parsed = parseJsonBody(body);
			if (!parsed) {
				return badRequest("invalid json body");
			}
			try {
				return await runAnnotation(tabs, id, parsed);
			} catch (error) {
				return error instanceof RefError
					? { status: 400, json: { ok: false, error: error.message } }
					: {
							status: 500,
							json: {
								ok: false,
								error:
									error instanceof Error ? error.message : "annotation failed",
							},
						};
			}
		}
	}

	// /tabs/:id[...]
	const tabMatch = path.match(/^\/tabs\/([^/]+)((?:\/[^/]+){0,2})$/);
	if (tabMatch) {
		const id = decodeURIComponent(tabMatch[1]);
		const sub = tabMatch[2] ?? "";

		if (sub === "" && method === "DELETE") {
			const closed = tabs.close(id);
			return closed ? { status: 200, json: { ok: true } } : notFound();
		}
		if (sub === "" && method === "GET") {
			const tab = tabs.list().find((t) => t.id === id);
			return tab ? { status: 200, json: { tab: tabView(tab) } } : notFound();
		}
		if (sub === "/title" && method === "GET") {
			const title = tabs.title(id);
			return title === null ? notFound() : { status: 200, json: { title } };
		}
		if (sub === "/context" && method === "POST") {
			if (!isJsonContentType(contentType)) {
				return unsupportedMediaType();
			}
			const parsed = parseJsonBody(body);
			if (!parsed) {
				return badRequest("invalid json body");
			}
			try {
				const context = await runContext(tabs, id, parsed);
				return context;
			} catch (error) {
				return {
					status: 500,
					json: {
						ok: false,
						error: error instanceof Error ? error.message : "context failed",
					},
				};
			}
		}
		if (sub === "/webmcp" && method === "GET") {
			try {
				const webmcpTools = await tabs.webmcpTools(id);
				return webmcpTools === null
					? notFound()
					: { status: 200, json: { tools: webmcpTools } };
			} catch (error) {
				return {
					status: 500,
					json: {
						error:
							error instanceof Error ? error.message : "WebMCP listing failed",
						ok: false,
					},
				};
			}
		}
		if (sub === "/webmcp/execute" && method === "POST") {
			if (!isJsonContentType(contentType)) {
				return unsupportedMediaType();
			}
			const parsed = parseJsonBody(body);
			if (!parsed) {
				return badRequest("invalid json body");
			}
			return runWebMCPExecute(tabs, id, parsed);
		}
		if (sub === "/navigate" && method === "POST") {
			if (!isJsonContentType(contentType)) {
				return unsupportedMediaType();
			}
			const parsed = parseJsonBody(body);
			const url = browserControlString(parsed?.url);
			if (url === undefined || url.trim() === "") {
				return badRequest("missing url");
			}
			let safeUrl: string;
			try {
				safeUrl = await validateNavigationUrl(url);
			} catch (error) {
				return badRequest(
					error instanceof Error ? error.message : "invalid url"
				);
			}
			const tab = tabs.navigate(id, safeUrl);
			return tab ? { status: 200, json: { tab: tabView(tab) } } : notFound();
		}
		if (sub === "/snapshot" && method === "POST") {
			// Body-less like /screenshot (the tab is the whole input, and it rides in
			// the path), so no Content-Type is demanded: nothing here is parsed.
			try {
				const snap = await tabs.snapshot(id);
				return snap === null ? notFound() : { status: 200, json: snap };
			} catch (e) {
				return {
					status: 500,
					json: {
						ok: false,
						error: e instanceof Error ? e.message : "snapshot failed",
					},
				};
			}
		}
		if (sub === "/screenshot" && method === "POST") {
			const png = await tabs.screenshot(id);
			return png === null
				? notFound()
				: {
						status: 200,
						json: { image: png, encoding: "base64", mime: "image/png" },
					};
		}
		if (sub === "/eval" && method === "POST") {
			// PRIVILEGED: runs arbitrary JS in the tab's web contents.
			if (!isJsonContentType(contentType)) {
				return unsupportedMediaType();
			}
			const parsed = parseJsonBody(body);
			const expression = browserControlString(parsed?.expression);
			if (expression === undefined || expression.trim() === "") {
				return badRequest("missing expression");
			}
			if (!tabs.list().some((t) => t.id === id)) {
				return notFound();
			}
			try {
				const result = await tabs.eval(id, expression);
				return { status: 200, json: { result } };
			} catch (e) {
				return {
					status: 500,
					json: {
						ok: false,
						error: e instanceof Error ? e.message : "eval failed",
					},
				};
			}
		}
	}

	return notFound();
}

/**
 * Start the loopback control server. Best-effort like the island's: a bind failure
 * (stale instance on the port) logs and leaves the app running rather than crashing.
 */
export function startControlServer(deps: RequestDeps, port: number): Server {
	const server = createServer((req, res) => {
		// Loopback-only is not enough: any web page can POST here (CSRF via
		// CORS-safelisted content types) and a DNS-rebound page can read state.
		// Reject anything that is not a plain local-process request BEFORE routing
		// (this also shields the unauthenticated `GET /health`).
		if (!isTrustedLocalRequest(req, port)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "forbidden" }));
			return;
		}
		const declaredLength = Number(req.headers["content-length"]);
		if (
			Number.isFinite(declaredLength) &&
			declaredLength >= 0 &&
			!bodyWithinControlLimit(declaredLength)
		) {
			res.writeHead(413, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({ ok: false, error: "request body is too large" })
			);
			req.resume();
			return;
		}
		const chunks: Buffer[] = [];
		let bodyBytes = 0;
		let tooLarge = false;
		req.on("data", (c) => {
			if (tooLarge) {
				return;
			}
			const chunk = z.instanceof(Buffer).parse(c);
			bodyBytes += chunk.length;
			if (!bodyWithinControlLimit(bodyBytes)) {
				tooLarge = true;
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({ ok: false, error: "request body is too large" })
				);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (tooLarge) {
				return;
			}
			const body = Buffer.concat(chunks).toString("utf8");
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const agentIds = url.searchParams.getAll("agent_id");
			if (agentIds.length > 1) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: "duplicate agent_id" }));
				return;
			}
			handleRequest(
				req.method ?? "GET",
				url.pathname,
				req.headers.authorization,
				body,
				deps,
				req.headers["content-type"],
				agentLaneForCaller(
					agentIds[0],
					browserControlString(req.headers["x-ryu-caller-agent-id"]),
					browserControlString(req.headers["x-ryu-caller-user-id"])
				)
			)
				.then((resp) => {
					if (resp.raw) {
						res.writeHead(resp.status, {
							"Content-Type": resp.raw.contentType,
						});
						res.end(resp.raw.body);
						return;
					}
					res.writeHead(resp.status, { "Content-Type": "application/json" });
					res.end(JSON.stringify(resp.json ?? {}));
				})
				.catch((e) => {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							ok: false,
							error: e instanceof Error ? e.message : "error",
						})
					);
				});
		});
	});
	server.on("error", (err) => {
		console.warn(`[ryu-browser] control server unavailable: ${err.message}`);
	});
	server.listen(port, "127.0.0.1");
	return server;
}
