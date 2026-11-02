import { describe, expect, it } from "bun:test";
import { createContext, Script } from "node:vm";
import { z } from "zod";
import {
	type RelayContents,
	type RelayMessageListener,
	WebAuthnBridge,
} from "./bridge.ts";
import type { RelayOutcome, SecurityKeyClient } from "./client.ts";
import {
	createWebAuthnInitScript,
	webAuthnSettleExpression,
} from "./init-script.ts";
import type { RelayRequest } from "./request.ts";

const CAPABILITY = "private-webauthn-capability";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const PRELUDE = `
globalThis.window = globalThis;
class DOMException extends Error { constructor(message, name) { super(message); this.name = name || "Error"; } }
class Credential {}
class PublicKeyCredential extends Credential {
  getClientExtensionResults() { throw new TypeError("Illegal invocation"); }
}
class AuthenticatorResponse {}
class AuthenticatorAssertionResponse extends AuthenticatorResponse {}
class AuthenticatorAttestationResponse extends AuthenticatorResponse {}
class CredentialsContainer {
  get(options) { globalThis.nativeCalls.push("get"); return Promise.resolve("native-get"); }
  create(options) { globalThis.nativeCalls.push("create"); return Promise.resolve("native-create"); }
}
Object.assign(globalThis, { DOMException, Credential, PublicKeyCredential, AuthenticatorResponse,
  AuthenticatorAssertionResponse, AuthenticatorAttestationResponse, CredentialsContainer });
globalThis.nativeCalls = [];
globalThis.navigator = { credentials: new CredentialsContainer() };
globalThis.capture = (promise) => promise.then(
  (value) => { globalThis.settled = { ok: true, value }; },
  (error) => { globalThis.settled = { ok: false, error }; });
globalThis.bytes = (buffer) => Array.from(new Uint8Array(buffer));
`;

function page(
	options: { onBinding?: (payload: string) => void; top?: boolean } = {}
) {
	const messages: string[] = [];
	const context = createContext({
		AbortController,
		__ryuWebAuthn(payload: unknown) {
			const text = z.string().parse(payload);
			messages.push(text);
			options.onBinding?.(text);
		},
	});
	new Script(PRELUDE).runInContext(context);
	if (options.top === false) {
		new Script("window.top = {};").runInContext(context);
	} else {
		new Script("window.top = window;").runInContext(context);
	}
	new Script(createWebAuthnInitScript(CAPABILITY)).runInContext(context);
	const run = (source: string): unknown =>
		new Script(source).runInContext(context);
	return {
		messages,
		/** Evaluate an expression in the page and return it as JSON-safe data. */
		read: (source: string): unknown =>
			JSON.parse(String(run(`JSON.stringify(${source})`))),
		run,
		settle: (
			requestId: number,
			message: unknown,
			capability = CAPABILITY
		): unknown => run(webAuthnSettleExpression(capability, requestId, message)),
	};
}

const GET_CALL = `capture(navigator.credentials.get({ publicKey: {
  challenge: new Uint8Array([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]).buffer,
  allowCredentials: [{ type: "public-key", id: new Uint8Array([251, 255]), transports: ["usb"] }],
  userVerification: "preferred",
}}))`;

const ASSERTION = {
	credential: {
		clientDataJSON: "e30",
		id: "AQID",
		response: {
			authenticatorData: "BAU",
			kind: "assertion",
			signature: "Bgc",
			userHandle: "CA",
		},
	},
	ok: true,
};

describe("WebAuthn init script", () => {
	it("hides the binding and serializes publicKey buffers to base64url", () => {
		const tab = page();
		expect(tab.read("typeof window.__ryuWebAuthn")).toBe("undefined");
		tab.run(GET_CALL);
		expect(tab.messages.map((m) => JSON.parse(m))).toEqual([
			{
				action: "request",
				capability: CAPABILITY,
				kind: "get",
				options: {
					allowCredentials: [
						{ id: "-_8", transports: ["usb"], type: "public-key" },
					],
					challenge: "AAECAwQFBgcICQoLDA0ODw",
					userVerification: "preferred",
				},
				requestId: 1,
			},
		]);
	});

	it("resolves a PublicKeyCredential-shaped assertion", async () => {
		const tab = page();
		tab.run(GET_CALL);
		expect(tab.settle(1, ASSERTION)).toBe(true);
		await flush();
		expect(
			tab.read(`(() => { const c = settled.value; const r = c.response; return {
  pkc: c instanceof PublicKeyCredential, assertion: r instanceof AuthenticatorAssertionResponse,
  id: c.id, type: c.type, attachment: c.authenticatorAttachment, rawId: bytes(c.rawId),
  clientData: bytes(r.clientDataJSON), authData: bytes(r.authenticatorData), sig: bytes(r.signature),
  user: bytes(r.userHandle), ext: c.getClientExtensionResults(), json: c.toJSON(),
  viaStringify: JSON.parse(JSON.stringify(c)).id }; })()`)
		).toEqual({
			assertion: true,
			attachment: "cross-platform",
			authData: [4, 5],
			clientData: [123, 125],
			ext: {},
			id: "AQID",
			json: {
				authenticatorAttachment: "cross-platform",
				clientExtensionResults: {},
				id: "AQID",
				rawId: "AQID",
				response: {
					authenticatorData: "BAU",
					clientDataJSON: "e30",
					signature: "Bgc",
					userHandle: "CA",
				},
				type: "public-key",
			},
			pkc: true,
			rawId: [1, 2, 3],
			sig: [6, 7],
			type: "public-key",
			user: [8],
			viaStringify: "AQID",
		});
	});

	it("resolves an attestation with transports, authenticator data and public key", async () => {
		const tab = page();
		tab.run(`capture(navigator.credentials.create({ publicKey: { challenge: new Uint8Array(16),
  rp: { name: "Example" }, user: { id: new Uint8Array([1]), name: "a", displayName: "A" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }] } }))`);
		expect(JSON.parse(tab.messages[0] ?? "{}").options.user.id).toBe("AQ");
		tab.settle(1, {
			credential: {
				clientDataJSON: "e30",
				id: "AQ",
				response: {
					attestationObject: "oA",
					authenticatorData: "Cg",
					kind: "attestation",
					publicKey: "Cw",
					publicKeyAlgorithm: -7,
					transports: ["usb", "nfc"],
				},
			},
			ok: true,
		});
		await flush();
		expect(
			tab.read(`(() => { const r = settled.value.response; return {
  attestation: r instanceof AuthenticatorAttestationResponse, object: bytes(r.attestationObject),
  transports: r.getTransports(), authData: bytes(r.getAuthenticatorData()), key: bytes(r.getPublicKey()),
  alg: r.getPublicKeyAlgorithm(), json: settled.value.toJSON().response }; })()`)
		).toEqual({
			alg: -7,
			attestation: true,
			authData: [10],
			json: {
				attestationObject: "oA",
				authenticatorData: "Cg",
				clientDataJSON: "e30",
				publicKey: "Cw",
				publicKeyAlgorithm: -7,
				transports: ["usb", "nfc"],
			},
			key: [11],
			object: [160],
			transports: ["usb", "nfc"],
		});
	});

	it("rejects with the DOMException or TypeError the main process names", async () => {
		const tab = page();
		tab.run(GET_CALL);
		tab.settle(1, {
			error: { message: "denied", name: "NotAllowedError" },
			ok: false,
		});
		await flush();
		expect(
			tab.read(
				"[settled.ok, settled.error instanceof DOMException, settled.error.name, settled.error.message]"
			)
		).toEqual([false, true, "NotAllowedError", "denied"]);
		tab.run(GET_CALL);
		tab.settle(2, {
			error: { message: "bad options", name: "TypeError" },
			ok: false,
		});
		await flush();
		expect(
			tab.read("[settled.error instanceof TypeError, settled.error.message]")
		).toEqual([true, "bad options"]);
	});

	it("falls back to the native call when told to", async () => {
		const tab = page();
		tab.run(GET_CALL);
		tab.settle(1, { fallback: true });
		await flush();
		expect(tab.read("[settled.value, nativeCalls]")).toEqual([
			"native-get",
			["get"],
		]);
	});

	it("ignores settles without the capability and cannot be replaced", async () => {
		const tab = page();
		tab.run(GET_CALL);
		expect(tab.settle(1, ASSERTION, "guessed")).toBe(false);
		expect(tab.settle(99, ASSERTION)).toBe(false);
		tab.run("try { window.__ryuWebAuthnSettle = () => true; } catch (_) {}");
		await flush();
		expect(tab.read("typeof settled")).toBe("undefined");
		expect(tab.settle(1, ASSERTION)).toBe(true);
		expect(tab.settle(1, ASSERTION)).toBe(false);
	});

	it("leaves conditional mediation, non-publicKey calls and frames native", async () => {
		const tab = page();
		tab.run(`navigator.credentials.get({ mediation: "conditional", publicKey: { challenge: new Uint8Array(16) } });
navigator.credentials.get({ password: true }); navigator.credentials.create({});`);
		expect(tab.messages).toEqual([]);
		expect(tab.read("nativeCalls")).toEqual(["get", "get", "create"]);
		const frame = page({ top: false });
		frame.run(GET_CALL);
		await flush();
		expect(frame.messages).toEqual([]);
		expect(frame.read("[nativeCalls, settled.value]")).toEqual([
			["get"],
			"native-get",
		]);
	});

	it("rejects with AbortError and tells the main process when the signal aborts", async () => {
		const tab = page();
		tab.run(`globalThis.controller = new AbortController();
capture(navigator.credentials.get({ signal: controller.signal, publicKey: { challenge: new Uint8Array(16) } }));`);
		tab.run("controller.abort()");
		await flush();
		expect(tab.read("settled.ok")).toBe(false);
		expect(tab.read("settled.error.name")).toBe("AbortError");
		expect(JSON.parse(tab.messages[1] ?? "{}")).toEqual({
			action: "cancel",
			capability: CAPABILITY,
			requestId: 1,
		});
		expect(tab.settle(1, ASSERTION)).toBe(false);
		tab.run(`globalThis.done = new AbortController(); done.abort();
capture(navigator.credentials.get({ signal: done.signal, publicKey: { challenge: new Uint8Array(16) } }));`);
		await flush();
		expect(tab.messages.length).toBe(2);
		expect(tab.read("settled.error.name")).toBe("AbortError");
	});
});

describe("WebAuthn relay end to end", () => {
	it("relays a page get through the bridge and resolves the page promise", async () => {
		const ceremonies: Promise<void>[] = [];
		const requests: RelayRequest[] = [];
		const hooks: { listener: RelayMessageListener | null } = { listener: null };
		let tab: ReturnType<typeof page> | null = null;
		const contents: RelayContents = {
			debugger: {
				on: (_event, next) => {
					hooks.listener = next;
				},
				removeListener: () => undefined,
				sendCommand: (method, params) => {
					if (method === "Page.getFrameTree") {
						return Promise.resolve({ frameTree: { frame: { id: "top" } } });
					}
					if (method === "Runtime.evaluate") {
						return Promise.resolve({
							result: { value: tab?.run(String(params?.expression)) },
						});
					}
					return Promise.resolve({});
				},
			},
			getURL: () => "https://accounts.example.com/login",
			isDestroyed: () => false,
			once: () => undefined,
		};
		const client: SecurityKeyClient = {
			request: (body: RelayRequest): Promise<RelayOutcome> => {
				requests.push(body);
				return Promise.resolve({
					credential: {
						id: "AQID",
						response: {
							authenticator_data: "BAU",
							kind: "assertion",
							signature: "Bgc",
							user_handle: null,
						},
					},
					status: "ok",
				});
			},
		};
		const bridge = new WebAuthnBridge(contents, client, null, CAPABILITY);
		await bridge.install();
		hooks.listener?.(null, "Runtime.executionContextCreated", {
			context: { auxData: { frameId: "top", isDefault: true }, id: 3 },
		});
		tab = page({
			onBinding: (payload) => {
				const done = bridge.handleMessage("Runtime.bindingCalled", {
					executionContextId: 3,
					name: "__ryuWebAuthn",
					payload,
				});
				if (done) {
					ceremonies.push(done);
				}
			},
		});
		tab.run(GET_CALL);
		await Promise.all(ceremonies);
		await flush();
		expect(requests[0]?.origin).toBe("https://accounts.example.com");
		expect(requests[0]?.rp_id).toBe("accounts.example.com");
		const clientData = Buffer.from(
			requests[0]?.client_data_json ?? "",
			"base64url"
		).toString("utf8");
		expect(
			tab.read(`(() => { const c = settled.value; return { pkc: c instanceof PublicKeyCredential,
  raw: bytes(c.response.clientDataJSON), user: c.response.userHandle }; })()`)
		).toEqual({
			pkc: true,
			raw: [...Buffer.from(clientData, "utf8")],
			user: null,
		});
	});
});
