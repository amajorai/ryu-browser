import { z } from "zod";
import { clampTimeout, type RelayRequest } from "./request.ts";

/** Kernel capability Core serves for the relay (`ryu-webauthn-relay::HOST_CAPABILITY`). */
export const SECURITY_KEY_CAPABILITY = "securityKey.request";
/** Extra time past the ceremony deadline before the sidecar gives up on Core. */
export const CORE_TIMEOUT_SLACK_MS = 5000;

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

const credentialSchema = z.object({
	id: b64url,
	response: z.discriminatedUnion("kind", [
		z.object({
			authenticator_data: b64url,
			kind: z.literal("assertion"),
			signature: b64url,
			user_handle: b64url.nullish(),
		}),
		z.object({
			attestation_object: b64url,
			kind: z.literal("attestation"),
			transports: z
				.array(z.string().max(32))
				.max(8)
				.default(() => []),
		}),
	]),
});
export type RelayCredential = z.output<typeof credentialSchema>;

/** Core's answer (`RelayOutcome`); every status but `ok` refuses the page. */
export const relayOutcomeSchema = z.discriminatedUnion("status", [
	z.object({ credential: credentialSchema, status: z.literal("ok") }),
	z.object({ reason: z.string().nullish(), status: z.literal("denied") }),
	z.object({ status: z.literal("disabled") }),
	z.object({ status: z.literal("timeout") }),
	z.object({ message: z.string(), status: z.literal("invalid") }),
]);
export type RelayOutcome = z.output<typeof relayOutcomeSchema>;

/** Sends one ceremony to Core and waits for the user's desktop to answer it. */
export interface SecurityKeyClient {
	request(body: RelayRequest, signal?: AbortSignal): Promise<RelayOutcome>;
}

const UNREACHABLE: RelayOutcome = {
	reason: "the Ryu security-key relay is unreachable",
	status: "denied",
};

/**
 * Core's kernel-capability client for `securityKey.request`, authenticated
 * like the vault client. Core holds the call until the user answers on their
 * desktop or the deadline passes. A network error, a non-2xx status or a
 * malformed body all read as `denied`, so the page always gets a refusal.
 */
export function createSecurityKeyClient(options: {
	corePort: number;
	fetchImpl?: typeof fetch;
	pluginId: string;
	token: string;
}): SecurityKeyClient {
	const doFetch = options.fetchImpl ?? fetch;
	return {
		async request(body, signal) {
			const deadline = AbortSignal.timeout(
				clampTimeout(body.timeout_ms) + CORE_TIMEOUT_SLACK_MS
			);
			let response: Response;
			try {
				response = await doFetch(
					`http://127.0.0.1:${options.corePort}/api/host/capability/${SECURITY_KEY_CAPABILITY}`,
					{
						body: JSON.stringify(body),
						headers: {
							authorization: `Bearer ${options.token}`,
							"content-type": "application/json",
							"x-ryu-plugin-id": options.pluginId,
						},
						method: "POST",
						redirect: "error",
						signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
					}
				);
			} catch {
				return { ...UNREACHABLE };
			}
			if (!response.ok) {
				return {
					reason: `the Ryu security-key relay refused the request (HTTP ${response.status})`,
					status: "denied",
				};
			}
			try {
				const parsed = relayOutcomeSchema.safeParse(await response.json());
				if (parsed.success) {
					return parsed.data;
				}
			} catch {
				// Fall through: an unreadable body is a refusal.
			}
			return {
				reason: "the Ryu security-key relay returned an invalid reply",
				status: "denied",
			};
		},
	};
}

/**
 * Build the client from what Core injects at spawn (`RYU_CORE_PORT`,
 * `RYU_EXT_TOKEN`, `RYU_EXT_PLUGIN_ID`). Null outside Core (standalone/dev
 * runs): the relay is then not installed and pages keep Chromium's own
 * WebAuthn.
 */
export function securityKeyClientFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	fetchImpl?: typeof fetch
): SecurityKeyClient | null {
	const port = Number((env.RYU_CORE_PORT ?? "").trim());
	const token = (env.RYU_EXT_TOKEN ?? "").trim();
	if (!(Number.isInteger(port) && port > 0 && port <= 65_535 && token)) {
		return null;
	}
	return createSecurityKeyClient({
		corePort: port,
		fetchImpl,
		pluginId: env.RYU_EXT_PLUGIN_ID?.trim() || "@ryu/browser",
		token,
	});
}
