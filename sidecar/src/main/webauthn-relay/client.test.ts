import { describe, expect, it } from "bun:test";
import {
	createSecurityKeyClient,
	type RelayOutcome,
	securityKeyClientFromEnv,
} from "./client.ts";
import type { RelayRequest } from "./request.ts";

const REQUEST: RelayRequest = {
	agent_id: null,
	client_data_json: "e30",
	kind: "get",
	options: { challenge: "AAECAwQFBgcICQoLDA0ODw", rpId: "example.com" },
	origin: "https://example.com",
	page_url: "https://example.com/login",
	rp_id: "example.com",
	timeout_ms: 30_000,
};

interface Captured {
	body: unknown;
	headers: Headers;
	init: RequestInit | undefined;
	url: string;
}

function fakeFetch(
	respond: () => Response | Promise<Response>,
	captured: Captured[] = []
): typeof fetch {
	const impl = async (
		input: RequestInfo | URL,
		init?: RequestInit
	): Promise<Response> => {
		captured.push({
			body: JSON.parse(String(init?.body)),
			headers: new Headers(init?.headers),
			init,
			url: String(input),
		});
		return await respond();
	};
	return impl as typeof fetch;
}

function client(
	respond: () => Response | Promise<Response>,
	captured: Captured[] = []
) {
	return createSecurityKeyClient({
		corePort: 8980,
		fetchImpl: fakeFetch(respond, captured),
		pluginId: "@ryu/browser",
		token: "ext-token",
	});
}

describe("createSecurityKeyClient", () => {
	it("posts the RelayRequest to Core's kernel capability with the sidecar credential", async () => {
		const captured: Captured[] = [];
		const outcome = await client(
			() =>
				Response.json({
					credential: {
						id: "AQID",
						response: {
							authenticator_data: "AA",
							kind: "assertion",
							signature: "AQ",
							user_handle: null,
						},
					},
					status: "ok",
				}),
			captured
		).request(REQUEST);
		expect(outcome).toEqual({
			credential: {
				id: "AQID",
				response: {
					authenticator_data: "AA",
					kind: "assertion",
					signature: "AQ",
					user_handle: null,
				},
			},
			status: "ok",
		});
		expect(captured[0]?.url).toBe(
			"http://127.0.0.1:8980/api/host/capability/securityKey.request"
		);
		expect(captured[0]?.init?.method).toBe("POST");
		expect(captured[0]?.init?.redirect).toBe("error");
		expect(captured[0]?.headers.get("authorization")).toBe("Bearer ext-token");
		expect(captured[0]?.headers.get("x-ryu-plugin-id")).toBe("@ryu/browser");
		expect(captured[0]?.headers.get("content-type")).toBe("application/json");
		expect(captured[0]?.body).toEqual(REQUEST);
	});

	it("passes every non-ok outcome through", async () => {
		for (const body of [
			{ reason: "user said no", status: "denied" },
			{ status: "disabled" },
			{ status: "timeout" },
			{ message: "bad rpId", status: "invalid" },
		] satisfies RelayOutcome[]) {
			expect(await client(() => Response.json(body)).request(REQUEST)).toEqual(
				body
			);
		}
	});

	it("defaults missing attestation transports", async () => {
		const outcome = await client(() =>
			Response.json({
				credential: {
					id: "AQ",
					response: { attestation_object: "oA", kind: "attestation" },
				},
				status: "ok",
			})
		).request({ ...REQUEST, kind: "create" });
		expect(outcome).toEqual({
			credential: {
				id: "AQ",
				response: {
					attestation_object: "oA",
					kind: "attestation",
					transports: [],
				},
			},
			status: "ok",
		});
	});

	it("reads a non-2xx status, malformed body or network failure as denied", async () => {
		const forbidden = await client(() =>
			Response.json({ error: "grant missing" }, { status: 403 })
		).request(REQUEST);
		expect(forbidden).toEqual({
			reason: "the Ryu security-key relay refused the request (HTTP 403)",
			status: "denied",
		});
		expect(
			(await client(() => new Response("not json")).request(REQUEST)).status
		).toBe("denied");
		expect(
			(
				await client(() =>
					Response.json({ status: "ok", credential: { id: "+/" } })
				).request(REQUEST)
			).status
		).toBe("denied");
		const offline = await client(() =>
			Promise.reject(new TypeError("connect ECONNREFUSED"))
		).request(REQUEST);
		expect(offline).toEqual({
			reason: "the Ryu security-key relay is unreachable",
			status: "denied",
		});
	});

	it("aborts the Core call when the caller's signal fires", async () => {
		const captured: Captured[] = [];
		const controller = new AbortController();
		const impl = async (
			input: RequestInfo | URL,
			init?: RequestInit
		): Promise<Response> => {
			captured.push({
				body: null,
				headers: new Headers(init?.headers),
				init,
				url: String(input),
			});
			return await new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError"))
				);
			});
		};
		const pending = createSecurityKeyClient({
			corePort: 1,
			fetchImpl: impl as typeof fetch,
			pluginId: "@ryu/browser",
			token: "t",
		}).request(REQUEST, controller.signal);
		controller.abort();
		expect((await pending).status).toBe("denied");
		expect(captured[0]?.init?.signal?.aborted).toBe(true);
	});
});

describe("securityKeyClientFromEnv", () => {
	it("needs Core's port and token", () => {
		expect(securityKeyClientFromEnv({})).toBeNull();
		expect(securityKeyClientFromEnv({ RYU_CORE_PORT: "8980" })).toBeNull();
		expect(
			securityKeyClientFromEnv({ RYU_CORE_PORT: "0", RYU_EXT_TOKEN: "t" })
		).toBeNull();
		expect(
			securityKeyClientFromEnv({ RYU_CORE_PORT: "70000", RYU_EXT_TOKEN: "t" })
		).toBeNull();
	});

	it("uses the injected plugin id, defaulting to @ryu/browser", async () => {
		const captured: Captured[] = [];
		const fetchImpl = fakeFetch(
			() => Response.json({ status: "timeout" }),
			captured
		);
		await securityKeyClientFromEnv(
			{ RYU_CORE_PORT: "9000", RYU_EXT_TOKEN: " tok " },
			fetchImpl
		)?.request(REQUEST);
		await securityKeyClientFromEnv(
			{
				RYU_CORE_PORT: "9000",
				RYU_EXT_PLUGIN_ID: "com.ryu.browser",
				RYU_EXT_TOKEN: "tok",
			},
			fetchImpl
		)?.request(REQUEST);
		expect(captured.map((call) => call.headers.get("x-ryu-plugin-id"))).toEqual(
			["@ryu/browser", "com.ryu.browser"]
		);
		expect(captured[0]?.headers.get("authorization")).toBe("Bearer tok");
		expect(captured[0]?.url).toBe(
			"http://127.0.0.1:9000/api/host/capability/securityKey.request"
		);
	});
});
