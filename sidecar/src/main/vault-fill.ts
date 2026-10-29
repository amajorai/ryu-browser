// Agent-account credential fill for the Ryu Browser sidecar.
//
// Agents can sign up for and log into websites with their OWN credentials, which
// live in the Ryu vault. The agent never sees a password, a TOTP seed, or a TOTP
// code: it names an account and an element ref, and this module asks Core for the
// value at the last possible moment and hands it straight to the page's editing
// pipeline. Nothing secret is returned to the caller, logged, or put in an error.
//
// Core binds every request to the page it is for: `vault.credentialFill` and
// `vault.totpEnroll` take the tab's CURRENT url as `page_url` and refuse a host
// that is not exactly the account's host (subdomains do not match), or a
// non-https page.
// The sidecar adds the checks only it can make, BEFORE the value is requested:
// focus must have landed in the top-level document (never inside an iframe, where
// a cross-origin frame could receive it), on the referenced element, on something
// that accepts text, and — for a password — on an `<input type=password>`.
//
// The Core call is dependency-injected (`VaultClient`) so the orchestration is
// unit-tested without Electron or a running Core. The control server's
// `/fill-credential` and `/capture-totp` routes are the only callers.

import { z } from "zod";
import { RefError } from "./tab-manager.ts";

export const credentialFieldSchema = z.enum([
	"username",
	"email",
	"password",
	"totp",
]);
export type CredentialField = z.output<typeof credentialFieldSchema>;

/** Upper bound on an account id the routes forward to Core. */
export const MAX_ACCOUNT_ID_LENGTH = 200;

/**
 * What the page reported about the element that actually holds focus after the
 * referenced element was focused. Produced by the Electron tab manager's in-page
 * probe; plain data so the refusal rules below are testable on their own.
 */
export const credentialTargetProbeSchema = z.object({
	/** True when focus is in a child frame, or the focused element IS a frame. */
	in_frame: z.boolean(),
	/** True when focus landed on the referenced element (or inside it / its label's control). */
	focused: z.boolean(),
	/** Upper-case tag name of the focused element, empty when nothing has focus. */
	tag: z.string(),
	/** Normalized `type` of a focused `<input>`. */
	input_type: z.string().optional(),
	/** Whether the focused element takes caret text (input/textarea/contenteditable). */
	editable: z.boolean(),
	disabled: z.boolean().optional(),
	read_only: z.boolean().optional(),
});
export type CredentialTargetProbe = z.output<
	typeof credentialTargetProbeSchema
>;

/** Input types that hold no caret-editable text (mirrors `assertCanAcceptText`). */
const OPAQUE_INPUT_TYPES = new Set([
	"button",
	"checkbox",
	"color",
	"file",
	"hidden",
	"image",
	"radio",
	"range",
	"reset",
	"submit",
]);

/**
 * Why a credential must NOT be requested for this focus target, or null when it
 * may. Unlike `type`, which fails open, this fails CLOSED: a secret that lands in
 * the wrong element (or a frame from another origin) is a leak, not a no-op.
 */
export function credentialTargetRefusal(
	probe: CredentialTargetProbe,
	field: CredentialField
): string | null {
	if (probe.in_frame) {
		return "focus is inside an iframe; credentials are only filled into the page's top-level document";
	}
	if (!(probe.focused && probe.tag)) {
		return "the element did not take focus (the page moved it elsewhere); snapshot again and pick the input itself";
	}
	if (!probe.editable) {
		return `the focused <${probe.tag.toLowerCase()}> cannot accept text`;
	}
	if (probe.disabled) {
		return "the focused field is disabled";
	}
	if (probe.read_only) {
		return "the focused field is read-only";
	}
	const inputType = probe.input_type?.toLowerCase();
	if (probe.tag === "INPUT" && inputType && OPAQUE_INPUT_TYPES.has(inputType)) {
		return `the focused <input type=${inputType}> cannot accept text`;
	}
	if (
		field === "password" &&
		!(probe.tag === "INPUT" && inputType === "password")
	) {
		return "a password is only filled into an <input type=password>; point ref at the password field";
	}
	return null;
}

/** A Core vault refusal or transport failure; `message` never carries a secret. */
export class VaultFillError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = "VaultFillError";
	}
}

export interface CredentialFillRequest {
	account: string;
	agent_id: string | null;
	field: CredentialField;
	page_url: string;
}

export interface TotpEnrollRequest {
	account: string;
	agent_id: string | null;
	page_url: string;
	secret: string;
}

/** The two kernel capabilities the browser calls (grant `vault:fill`). */
export interface VaultClient {
	/** Return the stored value (the CURRENT code for `totp`). Never log it. */
	credentialFill(request: CredentialFillRequest): Promise<string>;
	/** Store a TOTP seed for an account. Never log the secret. */
	totpEnroll(request: TotpEnrollRequest): Promise<void>;
}

/** The DOM steps a credential fill needs, supplied by the tab manager. */
export interface CredentialFillSteps {
	/** Insert `value` into the focused element, replacing its current content. */
	insert(value: string): Promise<void>;
	/** The tab's CURRENT url. */
	pageUrl(): string;
	/** Probe the element that holds focus now. */
	probe(): Promise<CredentialTargetProbe>;
}

/**
 * Check the focus target, request the value for the CURRENT page, re-check that
 * neither the page nor the focus moved while Core answered, then insert.
 *
 * Throws `RefError` (caller-fixable, 400) for a refused target and
 * `VaultFillError` for a vault refusal. The value only ever reaches `insert`.
 */
export async function performCredentialFill(
	steps: CredentialFillSteps,
	field: CredentialField,
	resolveValue: (pageUrl: string) => Promise<string>
): Promise<void> {
	const before = credentialTargetRefusal(await steps.probe(), field);
	if (before) {
		throw new RefError(`cannot fill ${field}: ${before}`);
	}
	const pageUrl = steps.pageUrl();
	const value = await resolveValue(pageUrl);
	if (value.length === 0) {
		throw new VaultFillError(404, `the account has no stored ${field}`);
	}
	// The vault call is a network round trip; a page can navigate or move focus
	// in the meantime. Only insert into the same page and the same kind of target
	// the value was released for.
	if (steps.pageUrl() !== pageUrl) {
		throw new RefError(
			`cannot fill ${field}: the page navigated while the credential was requested; snapshot again`
		);
	}
	const after = credentialTargetRefusal(await steps.probe(), field);
	if (after) {
		throw new RefError(`cannot fill ${field}: ${after}`);
	}
	await steps.insert(value);
}

const BASE32_RUN_RE = /^[A-Z2-7]+$/;
const OTPAUTH_URI_RE = /otpauth:\/\/totp\/[^\s"'<>]+/i;
/** Single-case runs of Base32 chunks joined by one space or dash. */
const BASE32_CHUNKED_RE =
	/(?:^|[^A-Za-z0-9])((?:[A-Z2-7]{3,128}(?:[ -][A-Z2-7]{3,128})*)|(?:[a-z2-7]{3,128}(?:[ -][a-z2-7]{3,128})*))(?=$|[^A-Za-z0-9])/g;
const SEPARATOR_RE = /[\s-]+/;
const DIGIT_RE = /[2-7]/;
const LOWER_RE = /[a-z]/;
const MIN_BASE32_SECRET = 16;
const MAX_BASE32_SECRET = 128;

/**
 * Whether a single-case run looks like a generated key rather than words, which
 * are valid Base32 too. A key almost always contains a digit; an all-caps key
 * without one is accepted only when written as one token or in equal-size
 * groups ("ABCD EFGH IJKL MNOP"), which prose like "ENTER THIS KEY" is not.
 */
function plausibleKey(chunks: readonly string[]): boolean {
	const run = chunks.join("");
	if (DIGIT_RE.test(run)) {
		return true;
	}
	if (LOWER_RE.test(run)) {
		return false;
	}
	return chunks.every((chunk) => chunk.length === chunks[0]?.length);
}

function normalizedBase32(chunks: readonly string[]): string | null {
	const compact = chunks.join("").toUpperCase();
	return BASE32_RUN_RE.test(compact) &&
		compact.length >= MIN_BASE32_SECRET &&
		compact.length <= MAX_BASE32_SECRET
		? compact
		: null;
}

/**
 * The chunk sequences of one run worth trying, best first: a label glued to a
 * grouped key ("KEY JBSW Y3DP EHPK 3PXP") must not become part of the secret, so
 * the longest stretch of equal-size groups (the last group may be shorter) and
 * any single long token are tried before the run as a whole.
 */
function keyCandidates(chunks: readonly string[]): string[][] {
	const out: string[][] = [];
	let best: string[] = [];
	for (let start = 0; start < chunks.length; start += 1) {
		const size = chunks[start]?.length ?? 0;
		let end = start + 1;
		while (end < chunks.length && chunks[end]?.length === size) {
			end += 1;
		}
		if (end < chunks.length && (chunks[end]?.length ?? 0) < size) {
			end += 1;
		}
		if (end - start > best.length) {
			best = chunks.slice(start, end);
		}
	}
	if (best.length > 1) {
		out.push(best);
	}
	for (const chunk of chunks) {
		if (chunk.length >= MIN_BASE32_SECRET) {
			out.push([chunk]);
		}
	}
	out.push([...chunks]);
	return out;
}

/**
 * Pull a TOTP secret out of what the page showed: an `otpauth://totp/...` URI
 * (from a decoded QR code or a link) or a Base32 setup key, possibly grouped with
 * spaces or dashes ("JBSW Y3DP EHPK 3PXP"). Candidates are tried in order, so a
 * decoded QR code wins over surrounding text. Returns the URI as-is, or the key
 * upper-cased with separators removed.
 */
export function extractTotpSecret(
	candidates: readonly (string | null | undefined)[]
): string | null {
	for (const raw of candidates) {
		const candidate = raw?.trim();
		if (!candidate) {
			continue;
		}
		const uri = candidate.match(OTPAUTH_URI_RE)?.[0];
		if (uri) {
			return uri;
		}
		for (const match of candidate.matchAll(BASE32_CHUNKED_RE)) {
			const chunks = (match[1] ?? "").split(SEPARATOR_RE);
			for (const option of keyCandidates(chunks)) {
				const secret = plausibleKey(option) ? normalizedBase32(option) : null;
				if (secret) {
					return secret;
				}
			}
		}
	}
	return null;
}

export const TOTP_NOT_FOUND_MESSAGE =
	'no TOTP setup key found: point ref at the QR code image or the text setup key (the "can\'t scan?" link usually reveals it)';

const coreErrorSchema = z.object({ error: z.string() });
const credentialFillReplySchema = z.object({ value: z.string() });

const MAX_SURFACED_ERROR = 300;
const VAULT_TIMEOUT_MS = 15_000;

async function coreErrorMessage(response: Response): Promise<string> {
	try {
		const parsed = coreErrorSchema.safeParse(await response.json());
		if (parsed.success && parsed.data.error.trim()) {
			return parsed.data.error.trim().slice(0, MAX_SURFACED_ERROR);
		}
	} catch {
		// A non-JSON error body carries nothing worth surfacing.
	}
	return `HTTP ${response.status}`;
}

/** Map a Core status onto what the browser route answers its own caller. */
function surfacedStatus(status: number): number {
	if (status === 401) {
		return 403;
	}
	if (status >= 400 && status < 500) {
		return status;
	}
	return 502;
}

/**
 * Core's kernel-capability client, with Core's `{error}` surfaced (the shared
 * `createSidecarHostClient` discards it, and "account belongs to another agent"
 * vs "page host does not match" is exactly what the agent needs to hear).
 */
export function createVaultClient(options: {
	corePort: number;
	fetchImpl?: typeof fetch;
	pluginId: string;
	timeoutMs?: number;
	token: string;
}): VaultClient {
	const doFetch = options.fetchImpl ?? fetch;
	const call = async (capability: string, body: object): Promise<Response> => {
		let response: Response;
		try {
			response = await doFetch(
				`http://127.0.0.1:${options.corePort}/api/host/capability/${capability}`,
				{
					body: JSON.stringify(body),
					headers: {
						authorization: `Bearer ${options.token}`,
						"content-type": "application/json",
						"x-ryu-plugin-id": options.pluginId,
					},
					method: "POST",
					redirect: "error",
					signal: AbortSignal.timeout(options.timeoutMs ?? VAULT_TIMEOUT_MS),
				}
			);
		} catch {
			throw new VaultFillError(
				502,
				"the Ryu vault is unreachable; retry when the node is ready"
			);
		}
		if (!response.ok) {
			const detail = await coreErrorMessage(response);
			throw new VaultFillError(
				surfacedStatus(response.status),
				response.status === 401 || response.status === 403
					? `the Ryu vault refused the request: ${detail}`
					: `the Ryu vault could not complete the request: ${detail}`
			);
		}
		return response;
	};
	return {
		async credentialFill(request) {
			const response = await call("vault.credentialFill", request);
			let parsed: z.ZodSafeParseResult<{ value: string }>;
			try {
				parsed = credentialFillReplySchema.safeParse(await response.json());
			} catch {
				throw new VaultFillError(
					502,
					"the Ryu vault returned an invalid reply"
				);
			}
			if (!parsed.success) {
				throw new VaultFillError(
					502,
					"the Ryu vault returned an invalid reply"
				);
			}
			return parsed.data.value;
		},
		async totpEnroll(request) {
			await call("vault.totpEnroll", request);
		},
	};
}

/**
 * Build the vault client from what Core injects at spawn (`RYU_CORE_PORT`,
 * `RYU_EXT_TOKEN`, `RYU_EXT_PLUGIN_ID`). Null outside Core (standalone/dev runs),
 * where the credential routes answer 503.
 */
export function vaultClientFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	fetchImpl?: typeof fetch
): VaultClient | null {
	const port = Number((env.RYU_CORE_PORT ?? "").trim());
	const token = (env.RYU_EXT_TOKEN ?? "").trim();
	if (!(Number.isInteger(port) && port > 0 && port <= 65_535 && token)) {
		return null;
	}
	return createVaultClient({
		corePort: port,
		fetchImpl,
		pluginId: env.RYU_EXT_PLUGIN_ID?.trim() || "@ryu/browser",
		token,
	});
}
