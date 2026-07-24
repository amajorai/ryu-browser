// Loopback control server for the Ryu Browser sidecar.
//
// The browser is a standalone Electron app that Core spawns as a `local` manifest
// sidecar (`apps-store/browser/manifest.json`, `SidecarProcess::Local`). It has no
// window chrome the user drives directly; instead it exposes a tiny HTTP control
// surface bound to loopback so Core (and, through Core's ext-proxy, the desktop
// panel) can list/open/navigate tabs, screenshot, and — privileged —
// evaluate JS in a tab. Mirrors the island's loopback control server posture
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
// * `POST /tabs/:id/eval` runs arbitrary JS in a tab's web contents. It is the
//   single privileged route; it is gated by the bearer like the rest and is the
//   reason `browser.control` is a grant-gated capability.
//
// The request-routing core (`handleRequest`) is a pure async function that takes an
// injected `TabManager`, so it is unit-tested with a fake — no Electron, no sockets.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { TabInfo, TabManager } from "./tab-manager.ts";

/** Default loopback port. Distinct from Core (:7980), mail (:7996), island (:7989). */
const BROWSER_CONTROL_BASE_PORT = 7993;
const DEV_PORT_OFFSET = 1000;

/**
 * Resolve the bind port. An explicit `RYU_BROWSER_PORT` wins (Core injects the
 * profile-shifted port via the manifest's `port_env`); else the default is shifted
 * by +1000 under `RYU_PROFILE=dev` so a dev browser runs ALONGSIDE a release one
 * without a port clash (mirrors the island's `resolveControlPort`).
 */
export function resolveControlPort(
	env: NodeJS.ProcessEnv = process.env
): number {
	const explicit = Number.parseInt(env.RYU_BROWSER_PORT ?? "", 10);
	if (Number.isInteger(explicit) && explicit > 0) {
		return explicit;
	}
	const isDev = (env.RYU_PROFILE ?? "").trim().toLowerCase() === "dev";
	return isDev
		? BROWSER_CONTROL_BASE_PORT + DEV_PORT_OFFSET
		: BROWSER_CONTROL_BASE_PORT;
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
	const raw = env.RYU_EXT_TOKEN ?? env.RYU_BROWSER_TOKEN ?? "";
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Constant-time bearer check. `null`/empty `expected` ⇒ fail-closed (reject all). */
export function bearerOk(
	authHeader: string | undefined,
	expected: string | null
): boolean {
	if (!expected) {
		return false;
	}
	const presented = authHeader?.startsWith("Bearer ")
		? authHeader.slice("Bearer ".length)
		: null;
	if (!presented) {
		return false;
	}
	const a = Buffer.from(presented, "utf8");
	const b = Buffer.from(expected, "utf8");
	// timingSafeEqual requires equal-length buffers; length mismatch is a definite
	// no-match, so short-circuit rather than leak the length via a throw.
	if (a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(a, b);
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

function parseJsonBody(raw: string): Record<string, unknown> | null {
	if (!raw) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

interface RequestDeps {
	tabs: TabManager;
	token: string | null;
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
	{ tabs, token }: RequestDeps,
	contentType?: string
): Promise<ControlResponse> {
	// Liveness — unauthenticated, reveals only version + tab count.
	if (method === "GET" && path === "/health") {
		return {
			status: 200,
			json: {
				ok: true,
				name: "ryu-browser",
				version: PACKAGE_VERSION,
				tabs: tabs.list().length,
			},
		};
	}

	// Everything below is protected.
	if (!bearerOk(authHeader, token)) {
		return { status: 401, json: { ok: false, error: "unauthorized" } };
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
			const tab = tabs.open(url);
			return { status: 201, json: { tab: tabView(tab) } };
		}
		return notFound();
	}

	// /tabs/:id[...]
	const tabMatch = path.match(/^\/tabs\/([^/]+)(\/[^/]+)?$/);
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
			const tab = tabs.navigate(id, parsed.url);
			return tab ? { status: 200, json: { tab: tabView(tab) } } : notFound();
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
			const path = (req.url ?? "/").split("?")[0];
			handleRequest(
				req.method ?? "GET",
				path,
				req.headers.authorization,
				body,
				deps,
				req.headers["content-type"]
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
		// biome-ignore lint/suspicious/noConsole: main-process diagnostic, no renderer.
		console.warn(`[ryu-browser] control server unavailable: ${err.message}`);
	});
	server.listen(port, "127.0.0.1");
	return server;
}
