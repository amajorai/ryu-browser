import { z } from "zod";

/**
 * Pure checks for one relayed WebAuthn ceremony: the page's `publicKey`
 * options, the tab's origin and relying party id, and the exact
 * `clientDataJSON` bytes the user's security key signs over.
 *
 * Nothing here trusts the page for its origin: the caller passes the URL the
 * Electron main process reads from the tab's top-level `webContents`.
 * Core (`ryu-webauthn-relay::validate_relay`) and the desktop re-run these
 * checks, including the public-suffix test this module cannot do without a
 * suffix list.
 */

/** Which WebAuthn call the page made (`get` signs in, `create` registers). */
export type CeremonyKind = "get" | "create";

/** Core's bounds on how long a ceremony may wait (`ryu-webauthn-relay`). */
export const MIN_TIMEOUT_MS = 10_000;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 120_000;
/** Upper bound on the serialized options Core accepts. */
export const MAX_OPTIONS_BYTES = 16 * 1024;
/** Most credentials a page may list. */
export const MAX_CREDENTIAL_DESCRIPTORS = 64;
const MIN_CHALLENGE_BYTES = 16;
const MAX_CHALLENGE_BYTES = 1024;
const MAX_USER_ID_BYTES = 64;
const MAX_CREDENTIAL_ID_BYTES = 1023;

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Encode bytes as base64url without padding. */
export function b64urlEncode(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

/** Decode strict base64url (no padding); null when the text is not canonical. */
export function b64urlDecode(text: string): Uint8Array | null {
	if (!BASE64URL.test(text) || text.length % 4 === 1) {
		return null;
	}
	const bytes = new Uint8Array(Buffer.from(text, "base64url"));
	return b64urlEncode(bytes) === text ? bytes : null;
}

function base64urlBytes(min: number, max: number) {
	return z.string().refine((text) => {
		const bytes = b64urlDecode(text);
		return bytes !== null && bytes.length >= min && bytes.length <= max;
	}, `must be base64url encoding ${min}-${max} bytes`);
}

const shortText = z.string().max(256);
/** Public-key credential type, the only one WebAuthn defines today. */
const PUBLIC_KEY = "public-key";
/** WebAuthn's defaults when a site lists no algorithm: ES256, then RS256. */
export const DEFAULT_PUB_KEY_CRED_PARAMS = [
	{ alg: -7, type: PUBLIC_KEY },
	{ alg: -257, type: PUBLIC_KEY },
] as const;

/**
 * Drop entries whose `type` is a credential type other than `public-key`, as
 * browsers do, so a site listing a future type still works. Entries with no
 * or a non-string `type` stay, and the item schema refuses them.
 */
function onlyPublicKeyEntries(list: unknown): unknown {
	if (!Array.isArray(list)) {
		return list;
	}
	return list.filter((entry: unknown) => {
		const type =
			typeof entry === "object" && entry !== null
				? Reflect.get(entry, "type")
				: undefined;
		return typeof type !== "string" || type === PUBLIC_KEY;
	});
}

/**
 * `pubKeyCredParams` as a browser reads it: an empty list means the defaults
 * (WebAuthn §5.1.3), and entries of another credential type are skipped. A
 * non-empty list left with no entry is refused by `prepareRelay`.
 */
function withDefaultAlgorithms(list: unknown): unknown {
	if (Array.isArray(list) && list.length === 0) {
		return DEFAULT_PUB_KEY_CRED_PARAMS.map((param) => ({ ...param }));
	}
	return onlyPublicKeyEntries(list);
}

/**
 * An optional WebAuthn enum member. Browsers ignore a value they do not
 * recognise and use the default, so an unknown one becomes `undefined`
 * instead of failing the ceremony.
 */
function lenientEnum<const T extends readonly [string, ...string[]]>(
	values: T
) {
	return z.enum(values).optional().catch(undefined);
}

const credentialDescriptor = z.object({
	id: base64urlBytes(1, MAX_CREDENTIAL_ID_BYTES),
	transports: z.array(z.string().max(32)).max(8).optional(),
	type: z.literal(PUBLIC_KEY),
});
const credentialDescriptors = z
	.preprocess(
		onlyPublicKeyEntries,
		z.array(credentialDescriptor).max(MAX_CREDENTIAL_DESCRIPTORS)
	)
	.optional();
const userVerification = lenientEnum(["required", "preferred", "discouraged"]);
const timeout = z.number().nonnegative().optional();
/** JSON-safe extension inputs, forwarded as the page gave them. */
const extensions = z.record(z.string().max(64), z.json()).optional();

export const getOptionsSchema = z.object({
	allowCredentials: credentialDescriptors,
	challenge: base64urlBytes(MIN_CHALLENGE_BYTES, MAX_CHALLENGE_BYTES),
	extensions,
	hints: z.array(shortText).max(8).optional(),
	rpId: shortText.optional(),
	timeout,
	userVerification,
});

export const createOptionsSchema = z.object({
	attestation: lenientEnum(["none", "indirect", "direct", "enterprise"]),
	authenticatorSelection: z
		.object({
			authenticatorAttachment: lenientEnum(["platform", "cross-platform"]),
			requireResidentKey: z.boolean().optional(),
			residentKey: lenientEnum(["discouraged", "preferred", "required"]),
			userVerification,
		})
		.optional(),
	challenge: base64urlBytes(MIN_CHALLENGE_BYTES, MAX_CHALLENGE_BYTES),
	excludeCredentials: credentialDescriptors,
	extensions,
	hints: z.array(shortText).max(8).optional(),
	pubKeyCredParams: z.preprocess(
		withDefaultAlgorithms,
		z
			.array(
				z.object({
					alg: z.number().int(),
					type: z.literal(PUBLIC_KEY),
				})
			)
			.max(32)
	),
	rp: z.object({ id: shortText.optional(), name: shortText }),
	timeout,
	user: z.object({
		displayName: shortText,
		id: base64urlBytes(1, MAX_USER_ID_BYTES),
		name: shortText,
	}),
});

export type GetOptions = z.output<typeof getOptionsSchema>;
export type CreateOptions = z.output<typeof createOptionsSchema>;

/** Body of `POST /api/host/capability/securityKey.request` (`RelayRequest`). */
export interface RelayRequest {
	agent_id: string | null;
	client_data_json: string;
	kind: CeremonyKind;
	options: GetOptions | CreateOptions;
	origin: string;
	page_url: string;
	rp_id: string;
	timeout_ms: number;
}

/** Why a ceremony was refused before it reached Core, as the page sees it. */
export interface PageError {
	message: string;
	name: "NotAllowedError" | "SecurityError" | "TypeError";
}

export class RelayRefusal extends Error {
	constructor(
		readonly page: PageError["name"],
		message: string
	) {
		super(message);
		this.name = "RelayRefusal";
	}
}

function isLocalhost(host: string): boolean {
	return host === "localhost" || host.endsWith(".localhost");
}

/**
 * Check the tab's own URL and the page's rpId: the origin must be https (or
 * http on localhost, as browsers allow), the host a domain (never an IP), and
 * the rpId the host or a dot-separated parent of it, with at least one dot.
 * Returns the serialized origin and the effective rpId.
 */
export function relyingPartyCheck(
	pageUrl: string,
	rpId: string | undefined
): { origin: string; rpId: string } {
	let url: URL;
	try {
		url = new URL(pageUrl);
	} catch {
		throw new RelayRefusal("SecurityError", "The page has no secure origin.");
	}
	const host = url.hostname.toLowerCase();
	const secure =
		url.protocol === "https:" ||
		(url.protocol === "http:" && isLocalhost(host));
	if (!secure || host === "" || IPV4.test(host) || host.startsWith("[")) {
		throw new RelayRefusal(
			"SecurityError",
			"Security keys need a secure (https) page with a domain name."
		);
	}
	const effective = rpId ?? host;
	const suffixOk =
		effective !== "" &&
		effective === effective.toLowerCase() &&
		!effective.startsWith(".") &&
		(host === effective || host.endsWith(`.${effective}`));
	if (!suffixOk) {
		throw new RelayRefusal(
			"SecurityError",
			"The relying party id is not valid for this page."
		);
	}
	if (!(isLocalhost(effective) || effective.includes("."))) {
		throw new RelayRefusal(
			"SecurityError",
			"The relying party id is a public suffix."
		);
	}
	return { origin: url.origin, rpId: effective };
}

/**
 * The exact `clientDataJSON` bytes: compact JSON in the key order the
 * WebAuthn spec serializes (`type`, `challenge`, `origin`, `crossOrigin`).
 */
export function buildClientDataJSON(
	kind: CeremonyKind,
	challenge: string,
	origin: string
): Uint8Array {
	const json = JSON.stringify({
		type: kind === "get" ? "webauthn.get" : "webauthn.create",
		challenge,
		origin,
		crossOrigin: false,
	});
	return new TextEncoder().encode(json);
}

/** Clamp a page's `timeout` to the bounds Core applies. */
export function clampTimeout(timeoutMs: number | undefined): number {
	const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

function firstIssue(error: z.ZodError): string {
	const issue = error.issues[0];
	const path = issue?.path.join(".") || "publicKey";
	return `Invalid publicKey options (${path}): ${issue?.message ?? "invalid"}`;
}

/** A validated ceremony, ready to send to Core. */
export interface PreparedRelay {
	clientDataJSON: string;
	request: RelayRequest;
}

/**
 * Validate one page request and build what Core receives. `pageUrl` must be
 * the main-process URL of the tab's top-level document.
 */
export function prepareRelay(input: {
	agentId: string | null;
	kind: CeremonyKind;
	options: unknown;
	pageUrl: string;
}): PreparedRelay {
	let options: GetOptions | CreateOptions;
	let declaredRpId: string | undefined;
	if (input.kind === "get") {
		const parsed = getOptionsSchema.safeParse(input.options);
		if (!parsed.success) {
			throw new RelayRefusal("TypeError", firstIssue(parsed.error));
		}
		options = parsed.data;
		declaredRpId = parsed.data.rpId;
	} else {
		const parsed = createOptionsSchema.safeParse(input.options);
		if (!parsed.success) {
			throw new RelayRefusal("TypeError", firstIssue(parsed.error));
		}
		// Only a list whose every entry is another credential type is left
		// empty; an empty list already became the defaults.
		if (parsed.data.pubKeyCredParams.length === 0) {
			throw new RelayRefusal(
				"NotAllowedError",
				"No supported public key algorithm was offered."
			);
		}
		options = parsed.data;
		declaredRpId = parsed.data.rp.id;
	}
	const { origin, rpId } = relyingPartyCheck(input.pageUrl, declaredRpId);
	const filled: GetOptions | CreateOptions =
		"rp" in options
			? { ...options, rp: { ...options.rp, id: rpId } }
			: { ...options, rpId };
	if (
		new TextEncoder().encode(JSON.stringify(filled)).length > MAX_OPTIONS_BYTES
	) {
		throw new RelayRefusal(
			"NotAllowedError",
			"The publicKey options are too large."
		);
	}
	const clientDataJSON = b64urlEncode(
		buildClientDataJSON(input.kind, options.challenge, origin)
	);
	return {
		clientDataJSON,
		request: {
			agent_id: input.agentId,
			client_data_json: clientDataJSON,
			kind: input.kind,
			options: filled,
			origin,
			page_url: input.pageUrl,
			rp_id: rpId,
			timeout_ms: clampTimeout(options.timeout),
		},
	};
}

const MAX_BINDING_PAYLOAD = 64 * 1024;

/** What the page's private binding sends the main process. */
export const bindingMessageSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("request"),
		capability: z.string().min(1),
		kind: z.enum(["get", "create"]),
		options: z.json(),
		requestId: z.number().int().positive(),
	}),
	z.object({
		action: z.literal("cancel"),
		capability: z.string().min(1),
		requestId: z.number().int().positive(),
	}),
]);
export type BindingMessage = z.output<typeof bindingMessageSchema>;

/** Parse a binding payload, or null when it is oversized or malformed. */
export function parseBindingMessage(payload: string): BindingMessage | null {
	if (payload.length > MAX_BINDING_PAYLOAD) {
		return null;
	}
	try {
		const parsed = bindingMessageSchema.safeParse(JSON.parse(payload));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
