import { z } from "zod";
//
// The request-routing core (`handleRequest`) is a pure async function that takes an
// injected `TabManager`, so it is unit-tested with a fake — no Electron, no sockets.

import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import {
	resolveSidecarPort,
	resolveSidecarToken,
	bearerOk as sharedBearerOk,
} from "@ryu/sidecar-runtime";

/** Default loopback port. Distinct from Core (:7980), mail (:7996), island (:7989). */
export const BROWSER_CONTROL_BASE_PORT = 7993;
/** Maximum request body accepted by the loopback control plane. */
export const MAX_CONTROL_BODY_BYTES = 1024 * 1024;

export const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"metadata",
	"metadata.google.internal",
	"metadata.goog",
	"host.docker.internal",
]);

export function blockedIpv4(address: string): boolean {
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

export function normalizedNavigationHost(url: URL): string {
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
