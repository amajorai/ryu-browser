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

import { createServer, type IncomingMessage, type Server } from "node:http";
import {
	resolveSidecarPort,
	resolveSidecarToken,
	bearerOk as sharedBearerOk,
} from "@ryu/sidecar-runtime";
import { OPENAPI_DOCUMENT } from "./openapi.ts";
import {
	type BrowserAnnotationInput,
	type BrowserAnnotationKind,
	type BrowserContextRequest,
	type BrowserMouseButton,
	type BrowserRect,
	type BrowserStyleAdjust,
	RefError,
	type ScrollDirection,
	type TabInfo,
	type TabManager,
} from "./tab-manager.ts";
import {
	parseWebMCPToolName,
	serializeWebMCPInput,
	WebMCPError,
} from "./webmcp.ts";

/** Default loopback port. Distinct from Core (:7980), mail (:7996), island (:7989). */
const BROWSER_CONTROL_BASE_PORT = 7993;

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
	return trimmed;
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
	if (typeof origin === "string" && origin.length > 0) {
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

const SCROLL_DIRECTIONS = new Set<string>(["down", "left", "right", "up"]);
/** Upper bound on a caller-supplied scroll distance, in CSS pixels. */
const MAX_SCROLL_AMOUNT = 100_000;
const MAX_COORDINATE_COUNT = 8;
const MOUSE_BUTTONS = new Set<BrowserMouseButton>(["left", "middle", "right"]);
const ANNOTATION_KINDS = new Set<BrowserAnnotationKind>([
	"area",
	"element",
	"elements",
]);

function parseJsonBody(raw: string): Record<string, unknown> | null {
	if (!raw) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function parseRect(value: unknown): BrowserRect | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const rect = value as Record<string, unknown>;
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

function parseSelections(value: unknown): BrowserRect[] | null {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > MAX_COORDINATE_COUNT) {
		return null;
	}
	const selections: BrowserRect[] = [];
	for (const item of value) {
		const rect = parseRect(item);
		if (!rect) {
			return null;
		}
		selections.push(rect);
	}
	return selections;
}

function parseStyle(value: unknown): BrowserStyleAdjust | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as BrowserStyleAdjust;
}

export interface RequestDeps {
	controlEnabled?: () => boolean;
	tabs: TabManager;
	tabsFor?: (agentId: string) => TabManager | null;
	token: string | null;
}

async function runClick(
	tabs: TabManager,
	tabId: string,
	parsed: Record<string, unknown>
): Promise<ControlResponse> {
	const ref = typeof parsed.ref === "string" ? parsed.ref.trim() : "";
	if (ref === "") {
		return badRequest("missing ref");
	}
	const result = await tabs.click(tabId, ref);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

async function runType(
	tabs: TabManager,
	tabId: string,
	parsed: Record<string, unknown>
): Promise<ControlResponse> {
	const ref = typeof parsed.ref === "string" ? parsed.ref.trim() : "";
	if (ref === "") {
		return badRequest("missing ref");
	}
	if (typeof parsed.text !== "string") {
		return badRequest("missing text");
	}
	const result = await tabs.type(
		tabId,
		ref,
		parsed.text,
		parsed.submit === true,
		parsed.replace === true
	);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

async function runScroll(
	tabs: TabManager,
	tabId: string,
	parsed: Record<string, unknown>
): Promise<ControlResponse> {
	const direction =
		typeof parsed.direction === "string" ? parsed.direction : "";
	if (!SCROLL_DIRECTIONS.has(direction)) {
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
	const result = await tabs.scroll(tabId, direction as ScrollDirection, amount);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

async function runContext(
	tabs: TabManager,
	tabId: string,
	parsed: Record<string, unknown>
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
	parsed: Record<string, unknown>
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
	const input =
		parsed.arguments === undefined
			? {}
			: typeof parsed.arguments === "object" &&
					parsed.arguments !== null &&
					!Array.isArray(parsed.arguments)
				? (parsed.arguments as Record<string, unknown>)
				: null;
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
		const execution = await tabs.webmcpExecute(tabId, name, input);
		if (!execution) {
			return noSuchTab(true);
		}
		return {
			status: 200,
			json: {
				origin: execution.tool.origin,
				result: execution.result,
				tool_name: execution.tool.name,
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
	parsed: Record<string, unknown>
): Promise<ControlResponse> {
	const kind = typeof parsed.kind === "string" ? parsed.kind : "";
	if (!ANNOTATION_KINDS.has(kind as BrowserAnnotationKind)) {
		return badRequest("kind must be area, element, or elements");
	}
	const comment =
		typeof parsed.comment === "string" ? parsed.comment.trim() : "";
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
		kind: kind as BrowserAnnotationKind,
		rect,
		selections: selections.length > 0 ? selections : [rect],
		style: parseStyle(parsed.style),
	} satisfies BrowserAnnotationInput);
	return result === null ? noSuchTab(true) : { status: 201, json: result };
}

async function runHover(
	tabs: TabManager,
	tabId: string,
	parsed: Record<string, unknown>
): Promise<ControlResponse> {
	const ref = typeof parsed.ref === "string" ? parsed.ref.trim() : "";
	if (!ref) {
		return badRequest("missing ref");
	}
	const result = await tabs.hover(tabId, ref);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

function parsePoint(value: unknown): { x: number; y: number } | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const point = value as Record<string, unknown>;
	const x = Number(point.x);
	const y = Number(point.y);
	return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

async function runClickAt(
	tabs: TabManager,
	tabId: string,
	parsed: Record<string, unknown>
): Promise<ControlResponse> {
	const x = Number(parsed.x);
	const y = Number(parsed.y);
	const button = parsed.button === undefined ? "left" : parsed.button;
	const count = parsed.count === undefined ? 1 : Number(parsed.count);
	if (
		!(Number.isFinite(x) && Number.isFinite(y)) ||
		typeof button !== "string" ||
		!MOUSE_BUTTONS.has(button as BrowserMouseButton) ||
		!Number.isInteger(count) ||
		count < 1 ||
		count > 3
	) {
		return badRequest("x/y, button, or count is invalid");
	}
	const result = await tabs.clickAt(
		tabId,
		x,
		y,
		button as BrowserMouseButton,
		count
	);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

async function runKey(
	tabs: TabManager,
	tabId: string,
	parsed: Record<string, unknown>
): Promise<ControlResponse> {
	if (
		!Array.isArray(parsed.keys) ||
		parsed.keys.length === 0 ||
		parsed.keys.length > 8 ||
		!parsed.keys.every((key) => typeof key === "string" && key.trim())
	) {
		return badRequest("keys must be a non-empty array of key names");
	}
	const result = await tabs.key(tabId, parsed.keys as string[]);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

async function runDrag(
	tabs: TabManager,
	tabId: string,
	parsed: Record<string, unknown>
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
 */
async function handleControlAction(
	method: string,
	path: string,
	parsed: Record<string, unknown>,
	tabs: TabManager
): Promise<ControlResponse> {
	if (method !== "POST") {
		return notFound();
	}
	const raw = parsed.tab_id;
	const explicit = typeof raw === "string" && raw.trim() !== "";
	const tabId = explicit ? (raw as string).trim() : tabs.activeId();
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
		return await runDrag(tabs, tabId, parsed);
	} catch (e) {
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
	tabs: TabManager
): Promise<ControlResponse> {
	const envelope = parseJsonBody(body);
	if (!envelope) {
		return badRequest("invalid json body");
	}
	const tool = typeof envelope.tool === "string" ? envelope.tool.trim() : "";
	const args =
		typeof envelope.args === "object" &&
		envelope.args !== null &&
		!Array.isArray(envelope.args)
			? (envelope.args as Record<string, unknown>)
			: {};

	if (tool === "browser.tabs") {
		return { status: 200, json: { tabs: tabs.list().map(tabView) } };
	}

	if (tool === "browser.navigate") {
		const url = typeof args.url === "string" ? args.url.trim() : "";
		if (url === "") {
			return badRequest("missing url");
		}
		let safeUrl: string;
		try {
			safeUrl = safeNavigationUrl(url);
		} catch (error) {
			return badRequest(error instanceof Error ? error.message : "invalid url");
		}
		const tab = tabs.open(safeUrl);
		return { status: 201, json: { tab: tabView(tab) } };
	}

	const tabId = typeof args.tab_id === "string" ? args.tab_id.trim() : "";
	if (tool === "browser.navigate_tab") {
		if (tabId === "") {
			return badRequest("missing tab_id");
		}
		const url = typeof args.url === "string" ? args.url.trim() : "";
		if (url === "") {
			return badRequest("missing url");
		}
		let safeUrl: string;
		try {
			safeUrl = safeNavigationUrl(url);
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
	{ controlEnabled, tabs: defaultTabs, tabsFor, token }: RequestDeps,
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
		agentId === undefined ? defaultTabs : (tabsFor?.(agentId) ?? null);
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
		return handleCapabilityBridge(body, tabs);
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
			const url = typeof parsed.url === "string" ? parsed.url : "about:blank";
			let safeUrl: string;
			try {
				safeUrl = safeNavigationUrl(url);
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
		path === "/drag"
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
		return await handleControlAction(method, path, parsed, tabs);
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
			if (
				!parsed ||
				typeof parsed.url !== "string" ||
				parsed.url.trim() === ""
			) {
				return badRequest("missing url");
			}
			let safeUrl: string;
			try {
				safeUrl = safeNavigationUrl(parsed.url);
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
			if (
				!parsed ||
				typeof parsed.expression !== "string" ||
				parsed.expression.trim() === ""
			) {
				return badRequest("missing expression");
			}
			if (!tabs.list().some((t) => t.id === id)) {
				return notFound();
			}
			try {
				const result = await tabs.eval(id, parsed.expression);
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
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => {
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
				agentIds[0]
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
