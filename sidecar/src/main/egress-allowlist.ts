// Per-lane egress allowlists for managed Bot browser sessions.
//
// Core names the calling agent on every Bot-lane request (`x-ryu-caller-agent-id`,
// stamped only after it verified the agent-lane proof). The same verified hop may
// carry that agent's host allowlist in `x-ryu-caller-egress-allowlist`. The
// sidecar reads the allowlist only alongside a verified agent lane, pins it to
// that lane, and the lane's own guarded SOCKS proxy refuses every destination the
// allowlist does not name. A request may keep or narrow a pinned allowlist but
// never widen it: a wider list takes effect only once the lane's session ends.
//
// Core stamps the header from the agent's stored egress policy, binds it into
// the agent-lane proof, and refuses any request that carries its own copy, so
// the value on a verified lane is Core's. A request that still carries the
// header more than once is refused outright (defense in depth): Node joins
// repeated custom headers with ", ", and the union of two copies would parse as
// one wider allowlist.

import { isIP } from "node:net";

/** Header Core uses to hand a verified agent lane its egress allowlist. */
export const EGRESS_ALLOWLIST_HEADER = "x-ryu-caller-egress-allowlist";

/**
 * How many times a request's raw header lines name the egress allowlist header.
 * `rawHeaders` alternates names and values, as Node's `IncomingMessage` gives it.
 */
export function egressAllowlistHeaderCount(
	rawHeaders: readonly string[]
): number {
	let count = 0;
	for (let index = 0; index < rawHeaders.length; index += 2) {
		if (rawHeaders[index]?.toLowerCase() === EGRESS_ALLOWLIST_HEADER) {
			count += 1;
		}
	}
	return count;
}

/** Most host patterns one lane may carry. */
export const MAX_EGRESS_PATTERNS = 32;

/** Longest DNS name a pattern may name. */
const MAX_HOST_LENGTH = 253;

const WILDCARD_PREFIX = "*.";
const IPV6_FAMILY = 6;
/** Userinfo, ports, paths, queries, fragments, escapes, and whitespace. */
const NOT_A_HOST = /[\s/?#@\\%]/;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A malformed allowlist, or one that would widen a lane's pinned allowlist. */
export class EgressAllowlistError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EgressAllowlistError";
	}
}

/** Sorted, de-duplicated, normalized host patterns. Empty means no egress. */
export type EgressAllowlist = readonly string[];

/**
 * Normalize a destination host the way the allowlist stores hosts: lowercase,
 * IDNA (punycode), no trailing dot, IPv6 without brackets. Returns null for
 * anything that is not a plain host.
 */
export function normalizeEgressHost(host: string): string | null {
	const trimmed = host.trim().replace(/\.$/, "");
	if (trimmed === "" || trimmed.length > MAX_HOST_LENGTH) {
		return null;
	}
	const bare = trimmed.replace(/^\[|\]$/g, "");
	if (
		NOT_A_HOST.test(bare) ||
		(bare.includes(":") && isIP(bare) !== IPV6_FAMILY)
	) {
		return null;
	}
	const urlHost = isIP(bare) === IPV6_FAMILY ? `[${bare}]` : bare;
	let parsed: URL;
	try {
		parsed = new URL(`http://${urlHost}/`);
	} catch {
		return null;
	}
	if (parsed.host !== parsed.hostname) {
		return null;
	}
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
	if (isIP(hostname)) {
		return hostname;
	}
	const labels = hostname.split(".");
	return labels.every((label) => HOST_LABEL.test(label)) ? hostname : null;
}

function normalizePattern(raw: string): string {
	const pattern = raw.trim().toLowerCase();
	const wildcard = pattern.startsWith(WILDCARD_PREFIX);
	const host = normalizeEgressHost(
		wildcard ? pattern.slice(WILDCARD_PREFIX.length) : pattern
	);
	if (!host || (wildcard && (isIP(host) !== 0 || !host.includes(".")))) {
		throw new EgressAllowlistError(
			"egress allowlist entries must be a host name or `*.` and a domain"
		);
	}
	return wildcard ? `${WILDCARD_PREFIX}${host}` : host;
}

/**
 * Parse Core's comma-separated allowlist header. `undefined` (no header)
 * returns null: the lane keeps what it already has. An empty value is an
 * explicit empty allowlist, which allows no destination at all.
 */
export function parseEgressAllowlist(
	raw: string | undefined
): EgressAllowlist | null {
	if (raw === undefined) {
		return null;
	}
	const entries = raw.split(",").filter((entry) => entry.trim() !== "");
	if (entries.length > MAX_EGRESS_PATTERNS) {
		throw new EgressAllowlistError(
			`egress allowlist may name at most ${MAX_EGRESS_PATTERNS} hosts`
		);
	}
	return [...new Set(entries.map(normalizePattern))].sort();
}

function patternAllows(pattern: string, host: string): boolean {
	if (!pattern.startsWith(WILDCARD_PREFIX)) {
		return pattern === host;
	}
	const suffix = pattern.slice(1);
	return (
		isIP(host) === 0 && host.endsWith(suffix) && host.length > suffix.length
	);
}

/** Whether `allowlist` admits a destination host (normalized here). */
export function egressHostAllowed(
	allowlist: EgressAllowlist,
	host: string
): boolean {
	const normalized = normalizeEgressHost(host);
	return (
		normalized !== null &&
		allowlist.some((pattern) => patternAllows(pattern, normalized))
	);
}

/** Whether every host `candidate` admits is also admitted by `current`. */
function patternCovered(candidate: string, current: EgressAllowlist): boolean {
	return current.some((pattern) => {
		if (pattern === candidate) {
			return true;
		}
		if (!candidate.startsWith(WILDCARD_PREFIX)) {
			return patternAllows(pattern, candidate);
		}
		// `*.a.example.com` is inside `*.example.com`, never inside an exact host.
		return (
			pattern.startsWith(WILDCARD_PREFIX) &&
			candidate.endsWith(pattern.slice(1))
		);
	});
}

/** Each managed Bot lane's pinned egress allowlist, for the life of its session. */
export class LaneEgressPolicies {
	private readonly pinned = new Map<string, EgressAllowlist>();

	/**
	 * Apply the allowlist a verified request carried for `lane`. No allowlist
	 * keeps the current one. A lane with none takes the first it is offered;
	 * after that a request may repeat or narrow it, and a wider one is refused.
	 */
	admit(lane: string, offered: EgressAllowlist | null): void {
		if (offered === null) {
			return;
		}
		const current = this.pinned.get(lane);
		if (
			current !== undefined &&
			!offered.every((pattern) => patternCovered(pattern, current))
		) {
			throw new EgressAllowlistError(
				"this Bot session's egress allowlist cannot be widened while the session is open"
			);
		}
		this.pinned.set(lane, offered);
	}

	/** The lane's pinned allowlist, or null when it has none (unrestricted). */
	allowlistFor(lane: string): EgressAllowlist | null {
		return this.pinned.get(lane) ?? null;
	}

	/** Whether the lane may reach `host`. A lane without an allowlist may reach any public host. */
	allows(lane: string, host: string): boolean {
		const allowlist = this.pinned.get(lane);
		return allowlist === undefined || egressHostAllowed(allowlist, host);
	}
}
