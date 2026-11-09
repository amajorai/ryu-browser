import { describe, expect, it } from "bun:test";
import {
	b64urlDecode,
	b64urlEncode,
	buildClientDataJSON,
	clampTimeout,
	parseBindingMessage,
	prepareRelay,
	RelayRefusal,
	relyingPartyCheck,
} from "./request.ts";

const CHALLENGE = b64urlEncode(Uint8Array.from({ length: 16 }, (_, i) => i));

function refusal(run: () => unknown): RelayRefusal {
	try {
		run();
	} catch (error) {
		if (error instanceof RelayRefusal) {
			return error;
		}
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("base64url", () => {
	it("round-trips and rejects padding, other alphabets and non-canonical tails", () => {
		const bytes = Uint8Array.from([251, 255, 0, 1, 2]);
		expect(b64urlEncode(bytes)).toBe("-_8AAQI");
		expect(Array.from(b64urlDecode("-_8AAQI") ?? [])).toEqual(
			Array.from(bytes)
		);
		expect(b64urlDecode("-_8AAQI=")).toBeNull();
		expect(b64urlDecode("+/8AAQI")).toBeNull();
		expect(b64urlDecode("A")).toBeNull();
		expect(Array.from(b64urlDecode("AQ") ?? [])).toEqual([1]);
		expect(b64urlDecode("AB")).toBeNull();
		expect(b64urlDecode("AF")).toBeNull(); // stray low bits
		expect(b64urlDecode("")?.length).toBe(0);
	});
});

describe("relyingPartyCheck", () => {
	it("defaults the rpId to the page host and serializes the origin", () => {
		expect(
			relyingPartyCheck("https://login.example.com:8443/a?b#c", undefined)
		).toEqual({
			origin: "https://login.example.com:8443",
			rpId: "login.example.com",
		});
		expect(relyingPartyCheck("https://example.com/", undefined).origin).toBe(
			"https://example.com"
		);
	});

	it("accepts the host or a dot-separated parent as the rpId", () => {
		expect(
			relyingPartyCheck("https://a.b.example.com/", "example.com").rpId
		).toBe("example.com");
		expect(
			relyingPartyCheck("https://a.b.example.com/", "b.example.com").rpId
		).toBe("b.example.com");
	});

	it("refuses an rpId that is not a suffix on a label boundary", () => {
		for (const rpId of [
			"badexample.com",
			"ample.com",
			"other.com",
			".example.com",
			"Example.com",
			"",
		]) {
			expect(
				refusal(() => relyingPartyCheck("https://example.com/", rpId)).page
			).toBe("SecurityError");
		}
		expect(
			refusal(() =>
				relyingPartyCheck("https://example.com/", "www.example.com")
			).page
		).toBe("SecurityError");
	});

	it("refuses single-label rpIds such as a bare TLD", () => {
		expect(
			refusal(() => relyingPartyCheck("https://example.com/", "com")).message
		).toContain("public suffix");
	});

	it("requires https with a domain, allowing http only on localhost", () => {
		for (const url of [
			"http://example.com/",
			"https://127.0.0.1/",
			"https://[::1]/",
			"file:///tmp/a.html",
			"about:blank",
			"not a url",
		]) {
			expect(refusal(() => relyingPartyCheck(url, undefined)).page).toBe(
				"SecurityError"
			);
		}
		expect(relyingPartyCheck("http://localhost:3000/", undefined)).toEqual({
			origin: "http://localhost:3000",
			rpId: "localhost",
		});
		expect(relyingPartyCheck("http://app.localhost/", undefined).rpId).toBe(
			"app.localhost"
		);
	});
});

describe("buildClientDataJSON", () => {
	it("serializes compact JSON in spec key order", () => {
		const bytes = buildClientDataJSON("get", CHALLENGE, "https://example.com");
		expect(new TextDecoder().decode(bytes)).toBe(
			'{"type":"webauthn.get","challenge":"AAECAwQFBgcICQoLDA0ODw","origin":"https://example.com","crossOrigin":false}'
		);
		expect(
			new TextDecoder().decode(
				buildClientDataJSON("create", CHALLENGE, "https://a.test")
			)
		).toBe(
			'{"type":"webauthn.create","challenge":"AAECAwQFBgcICQoLDA0ODw","origin":"https://a.test","crossOrigin":false}'
		);
	});
});

describe("clampTimeout", () => {
	it("applies Core's bounds and default", () => {
		expect(clampTimeout(undefined)).toBe(60_000);
		expect(clampTimeout(0)).toBe(10_000);
		expect(clampTimeout(30_000.4)).toBe(30_000);
		expect(clampTimeout(10_000_000)).toBe(120_000);
	});
});

describe("prepareRelay", () => {
	it("builds a get request from the tab URL, never from the page", () => {
		const prepared = prepareRelay({
			agentId: "agent-7",
			kind: "get",
			options: {
				allowCredentials: [
					{ id: "AQID", transports: ["usb"], type: "public-key" },
				],
				challenge: CHALLENGE,
				origin: "https://attacker.test",
				timeout: 30_000,
				userVerification: "preferred",
			},
			pageUrl: "https://accounts.example.com/signin",
		});
		expect(prepared.request).toEqual({
			agent_id: "agent-7",
			client_data_json: prepared.clientDataJSON,
			kind: "get",
			options: {
				allowCredentials: [
					{ id: "AQID", transports: ["usb"], type: "public-key" },
				],
				challenge: CHALLENGE,
				rpId: "accounts.example.com",
				timeout: 30_000,
				userVerification: "preferred",
			},
			origin: "https://accounts.example.com",
			page_url: "https://accounts.example.com/signin",
			rp_id: "accounts.example.com",
			timeout_ms: 30_000,
		});
		const clientData = JSON.parse(
			new TextDecoder().decode(
				b64urlDecode(prepared.clientDataJSON) ?? new Uint8Array()
			)
		);
		expect(clientData).toEqual({
			challenge: CHALLENGE,
			crossOrigin: false,
			origin: "https://accounts.example.com",
			type: "webauthn.get",
		});
	});

	it("fills rp.id for create and keeps the registration fields", () => {
		const prepared = prepareRelay({
			agentId: null,
			kind: "create",
			options: {
				authenticatorSelection: { residentKey: "preferred" },
				challenge: CHALLENGE,
				pubKeyCredParams: [{ alg: -7, type: "public-key" }],
				rp: { id: "example.com", name: "Example" },
				user: { displayName: "Ada", id: "dXNlcg", name: "ada" },
			},
			pageUrl: "https://www.example.com/register",
		});
		expect(prepared.request.rp_id).toBe("example.com");
		expect(prepared.request.agent_id).toBeNull();
		expect(prepared.request.options).toMatchObject({
			rp: { id: "example.com", name: "Example" },
		});
		expect(prepared.request.timeout_ms).toBe(60_000);
	});

	it("refuses malformed options with a TypeError naming the field", () => {
		const short = refusal(() =>
			prepareRelay({
				agentId: null,
				kind: "get",
				options: { challenge: "AAEC" },
				pageUrl: "https://example.com/",
			})
		);
		expect(short.page).toBe("TypeError");
		expect(short.message).toContain("challenge");
		const tooMany = refusal(() =>
			prepareRelay({
				agentId: null,
				kind: "get",
				options: {
					allowCredentials: Array.from({ length: 65 }, () => ({
						id: "AQ",
						type: "public-key",
					})),
					challenge: CHALLENGE,
				},
				pageUrl: "https://example.com/",
			})
		);
		expect(tooMany.message).toContain("allowCredentials");
		expect(
			refusal(() =>
				prepareRelay({
					agentId: null,
					kind: "create",
					options: { challenge: CHALLENGE },
					pageUrl: "https://example.com/",
				})
			).page
		).toBe("TypeError");
	});

	it("treats an empty algorithm list as WebAuthn's ES256/RS256 defaults", () => {
		const prepared = prepareRelay({
			agentId: null,
			kind: "create",
			options: {
				challenge: CHALLENGE,
				pubKeyCredParams: [],
				rp: { name: "Example" },
				user: { displayName: "Ada", id: "dXNlcg", name: "ada" },
			},
			pageUrl: "https://example.com/",
		});
		expect(
			(prepared.request.options as { pubKeyCredParams: unknown })
				.pubKeyCredParams
		).toEqual([
			{ alg: -7, type: "public-key" },
			{ alg: -257, type: "public-key" },
		]);
	});

	it("skips credential types it does not know, as browsers do", () => {
		const prepared = prepareRelay({
			agentId: null,
			kind: "create",
			options: {
				challenge: CHALLENGE,
				excludeCredentials: [
					{ id: "AQID", type: "future-key" },
					{ id: "BAUG", type: "public-key" },
				],
				pubKeyCredParams: [
					{ alg: -7, type: "future-key" },
					{ alg: -8, type: "public-key" },
				],
				rp: { name: "Example" },
				user: { displayName: "Ada", id: "dXNlcg", name: "ada" },
			},
			pageUrl: "https://example.com/",
		});
		const options = prepared.request.options as {
			excludeCredentials: unknown;
			pubKeyCredParams: unknown;
		};
		expect(options.pubKeyCredParams).toEqual([{ alg: -8, type: "public-key" }]);
		expect(options.excludeCredentials).toEqual([
			{ id: "BAUG", type: "public-key" },
		]);
		const signIn = prepareRelay({
			agentId: null,
			kind: "get",
			options: {
				allowCredentials: [{ id: "AQID", type: "future-key" }],
				challenge: CHALLENGE,
			},
			pageUrl: "https://example.com/",
		});
		expect(
			(signIn.request.options as { allowCredentials: unknown }).allowCredentials
		).toEqual([]);
	});

	it("drops enum values it does not recognise instead of failing", () => {
		const prepared = prepareRelay({
			agentId: null,
			kind: "create",
			options: {
				attestation: "future-attestation",
				authenticatorSelection: {
					authenticatorAttachment: "future-attachment",
					residentKey: "future-resident-key",
					userVerification: "future-uv",
				},
				challenge: CHALLENGE,
				pubKeyCredParams: [{ alg: -7, type: "public-key" }],
				rp: { name: "Example" },
				user: { displayName: "Ada", id: "dXNlcg", name: "ada" },
			},
			pageUrl: "https://example.com/",
		});
		const sent = JSON.parse(JSON.stringify(prepared.request.options));
		expect(sent.attestation).toBeUndefined();
		expect(sent.authenticatorSelection).toEqual({});
		const signIn = prepareRelay({
			agentId: null,
			kind: "get",
			options: { challenge: CHALLENGE, userVerification: "future-uv" },
			pageUrl: "https://example.com/",
		});
		expect(
			JSON.parse(JSON.stringify(signIn.request.options)).userVerification
		).toBeUndefined();
	});

	it("refuses only-unknown algorithms and an rpId for another site", () => {
		const base = {
			challenge: CHALLENGE,
			rp: { name: "Example" },
			user: { displayName: "Ada", id: "dXNlcg", name: "ada" },
		};
		expect(
			refusal(() =>
				prepareRelay({
					agentId: null,
					kind: "create",
					options: {
						...base,
						pubKeyCredParams: [{ alg: -7, type: "future-key" }],
					},
					pageUrl: "https://example.com/",
				})
			).page
		).toBe("NotAllowedError");
		expect(
			refusal(() =>
				prepareRelay({
					agentId: null,
					kind: "get",
					options: { challenge: CHALLENGE, rpId: "bank.test" },
					pageUrl: "https://example.com/",
				})
			).page
		).toBe("SecurityError");
	});

	it("refuses options larger than Core accepts", () => {
		const large = refusal(() =>
			prepareRelay({
				agentId: null,
				kind: "get",
				options: {
					allowCredentials: Array.from({ length: 64 }, () => ({
						id: b64urlEncode(new Uint8Array(300)),
						type: "public-key",
					})),
					challenge: CHALLENGE,
				},
				pageUrl: "https://example.com/",
			})
		);
		expect(large.message).toContain("too large");
	});
});

describe("parseBindingMessage", () => {
	it("accepts request and cancel messages only", () => {
		expect(
			parseBindingMessage(
				JSON.stringify({
					action: "request",
					capability: "c",
					kind: "get",
					options: {},
					requestId: 1,
				})
			)
		).toMatchObject({ action: "request", kind: "get", requestId: 1 });
		expect(
			parseBindingMessage(
				JSON.stringify({ action: "cancel", capability: "c", requestId: 2 })
			)
		).toEqual({
			action: "cancel",
			capability: "c",
			requestId: 2,
		});
		expect(parseBindingMessage("{")).toBeNull();
		expect(
			parseBindingMessage(
				JSON.stringify({ action: "sign", capability: "c", requestId: 1 })
			)
		).toBeNull();
		expect(
			parseBindingMessage(
				JSON.stringify({
					action: "request",
					capability: "c",
					kind: "get",
					options: {},
					requestId: 0,
				})
			)
		).toBeNull();
		expect(parseBindingMessage("x".repeat(70_000))).toBeNull();
	});
});
