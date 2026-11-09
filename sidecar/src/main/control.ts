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

import {
	handleControlAction,
	runAnnotation,
	runContext,
	runWebMCPExecute,
} from "./control-actions.ts";
import { handleCapabilityBridge } from "./control-bridge.ts";
import { handleLiveViewRoute } from "./control-live-view.ts";
import {
	badRequest,
	type ControlResponse,
	notFound,
	PACKAGE_VERSION,
	parseJsonBody,
	parseThemeTokens,
	type RequestDeps,
	tabView,
	unsupportedMediaType,
} from "./control-parsing.ts";
import { handleProfileRoute } from "./control-profiles.ts";
import { browserControlString } from "./control-records.ts";
import { EgressAllowlistError } from "./egress-allowlist.ts";
import { laneSessionId } from "./lane-session.ts";
import {
	bearerOk,
	isJsonContentType,
	safeNavigationUrl,
} from "./navigation-safety.ts";
import { OPENAPI_DOCUMENT } from "./openapi.ts";
import { RefError, type TabManager } from "./tab-manager.ts";

// The loopback screening helpers live in `navigation-safety.ts`; the control
// surface keeps exporting them so callers and tests have one entry point.
export {
	agentLaneForCaller,
	bearerOk,
	blockedNavigationAddress,
	bodyWithinControlLimit,
	isJsonContentType,
	isTrustedLocalRequest,
	resolveControlPort,
	resolveControlToken,
	safeNavigationUrl,
	safeNavigationUrlResolved,
} from "./navigation-safety.ts";

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
		liveView,
		profileLanes,
		setTheme,
		tabs: defaultTabs,
		tabsFor,
		token,
		validateNavigationUrl = safeNavigationUrl,
		vault,
	}: RequestDeps,
	contentType?: string,
	agentId?: string,
	egressAllowlist?: string
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
	// The owner's read-only live view of Bot lanes. Answered before any lane is
	// resolved so it never creates one, and refused to agent lanes.
	const liveViewReply = await handleLiveViewRoute(
		method,
		path,
		agentId,
		liveView
	);
	if (liveViewReply) {
		return liveViewReply;
	}
	// Profiles and lane sessions: answered before any lane is resolved, so
	// listing or closing a session never opens one.
	const profileReply = await handleProfileRoute(
		method,
		path,
		agentId,
		profileLanes
	);
	if (profileReply) {
		return profileReply;
	}
	// Resolve a managed Bot's hidden tab lane only after authentication and the
	// user-controlled Browser capability gate. This prevents unauthenticated
	// requests from lazily creating windows or Chromium state.
	// Core's allowlist for the lane rides the same verified hop; a malformed or
	// widening one refuses the request rather than opening the lane without it.
	let tabs: TabManager | null;
	try {
		tabs =
			agentId === undefined
				? defaultTabs
				: ((await tabsFor?.(agentId, egressAllowlist)) ?? null);
	} catch (error) {
		if (error instanceof EgressAllowlistError) {
			return { status: 403, json: { ok: false, error: error.message } };
		}
		throw error;
	}
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
			// Only an agent lane has a browser session Core can pin attached items to.
			browserSession: agentId === undefined ? undefined : laneSessionId(tabs),
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
