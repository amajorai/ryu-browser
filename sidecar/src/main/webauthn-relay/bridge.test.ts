import { describe, expect, it } from "bun:test";
import {
	type PageSettlement,
	type RelayContents,
	type RelayMessageListener,
	settlementFor,
	WebAuthnBridge,
} from "./bridge.ts";
import type { RelayOutcome, SecurityKeyClient } from "./client.ts";
import { prepareRelay, type RelayRequest } from "./request.ts";

const CAPABILITY = "tab-capability";
const CHALLENGE = "AAECAwQFBgcICQoLDA0ODw";
const OK_ASSERTION: RelayOutcome = {
	credential: {
		id: "AQID",
		response: {
			authenticator_data: "BAU",
			kind: "assertion",
			signature: "Bgc",
			user_handle: "CA",
		},
	},
	status: "ok",
};

class FakeContents implements RelayContents {
	url = "https://accounts.example.com/login";
	destroyed = false;
	readonly commands: { method: string; params?: Record<string, unknown> }[] =
		[];
	readonly listeners: RelayMessageListener[] = [];
	private onDestroyed: (() => void) | null = null;
	readonly debugger = {
		on: (_event: "message", listener: RelayMessageListener) => {
			this.listeners.push(listener);
		},
		removeListener: (_event: "message", listener: RelayMessageListener) => {
			this.listeners.splice(this.listeners.indexOf(listener), 1);
		},
		sendCommand: (
			method: string,
			params?: Record<string, unknown>
		): Promise<unknown> => {
			this.commands.push({ method, params });
			if (method === "Page.getFrameTree") {
				return Promise.resolve({ frameTree: { frame: { id: "top" } } });
			}
			return Promise.resolve({});
		},
	};
	getURL(): string {
		return this.url;
	}
	isDestroyed(): boolean {
		return this.destroyed;
	}
	once(_event: "destroyed", listener: () => void): void {
		this.onDestroyed = listener;
	}
	destroy(): void {
		this.destroyed = true;
		this.onDestroyed?.();
	}
	/** Every settlement the bridge evaluated into the page, by request id. */
	settlements(): {
		contextId: unknown;
		requestId: number;
		settlement: PageSettlement;
	}[] {
		return this.commands
			.filter((command) => command.method === "Runtime.evaluate")
			.map((command) => {
				const expression = String(command.params?.expression);
				const match = expression.match(/, (\d+), ("(?:[^"\\]|\\.)*")\)$/);
				if (
					!(
						match?.[1] &&
						match[2] &&
						expression.includes(JSON.stringify(CAPABILITY))
					)
				) {
					throw new Error(`unexpected expression ${expression}`);
				}
				return {
					contextId: command.params?.contextId,
					requestId: Number(match[1]),
					settlement: JSON.parse(JSON.parse(match[2])),
				};
			});
	}
}

class FakeClient implements SecurityKeyClient {
	readonly calls: { body: RelayRequest; signal?: AbortSignal }[] = [];
	private readonly resolvers: ((outcome: RelayOutcome) => void)[] = [];
	request(body: RelayRequest, signal?: AbortSignal): Promise<RelayOutcome> {
		this.calls.push({ body, signal });
		return new Promise((resolve) => {
			this.resolvers.push(resolve);
			signal?.addEventListener("abort", () => resolve({ status: "denied" }));
		});
	}
	answer(outcome: RelayOutcome, index = 0): void {
		this.resolvers[index]?.(outcome);
	}
}

async function fixture(agentId: string | null = null) {
	const contents = new FakeContents();
	const client = new FakeClient();
	const bridge = new WebAuthnBridge(contents, client, agentId, CAPABILITY);
	await bridge.install();
	bridge.handleMessage("Runtime.executionContextCreated", {
		context: { auxData: { frameId: "top", isDefault: true }, id: 1 },
	});
	bridge.handleMessage("Runtime.executionContextCreated", {
		context: { auxData: { frameId: "child", isDefault: true }, id: 2 },
	});
	const call = (
		fields: Record<string, unknown> = {},
		contextId = 1,
		name = "__ryuWebAuthn"
	) =>
		bridge.handleMessage("Runtime.bindingCalled", {
			executionContextId: contextId,
			name,
			payload: JSON.stringify({
				action: "request",
				capability: CAPABILITY,
				kind: "get",
				options: { challenge: CHALLENGE },
				requestId: 1,
				...fields,
			}),
		});
	return { bridge, call, client, contents };
}

describe("WebAuthnBridge.install", () => {
	it("adds the private binding and the init script carrying the tab capability", async () => {
		const { contents } = await fixture();
		expect(contents.commands.map((c) => c.method)).toEqual([
			"Runtime.enable",
			"Page.enable",
			"Runtime.addBinding",
			"Page.getFrameTree",
			"Page.addScriptToEvaluateOnNewDocument",
		]);
		expect(contents.commands[2]?.params).toEqual({ name: "__ryuWebAuthn" });
		expect(String(contents.commands[4]?.params?.source)).toContain(
			JSON.stringify(CAPABILITY)
		);
		expect(contents.listeners.length).toBe(1);
	});
});

describe("WebAuthnBridge ceremonies", () => {
	it("relays a top-frame get and settles it with the credential and its clientDataJSON", async () => {
		const { call, client, contents } = await fixture("agent-7");
		const done = call();
		expect(client.calls[0]?.body).toMatchObject({
			agent_id: "agent-7",
			kind: "get",
			origin: "https://accounts.example.com",
			page_url: "https://accounts.example.com/login",
			rp_id: "accounts.example.com",
		});
		client.answer(OK_ASSERTION);
		await done;
		expect(contents.settlements()).toEqual([
			{
				contextId: 1,
				requestId: 1,
				settlement: {
					credential: {
						clientDataJSON: client.calls[0]?.body.client_data_json ?? "",
						id: "AQID",
						response: {
							authenticatorData: "BAU",
							kind: "assertion",
							signature: "Bgc",
							userHandle: "CA",
						},
					},
					ok: true,
				},
			},
		]);
	});

	it("drops calls from frames, unknown contexts, other bindings or without the capability", async () => {
		const { call, client, contents } = await fixture();
		expect(call({}, 2)).toBeUndefined();
		expect(call({}, 9)).toBeUndefined();
		expect(call({}, 1, "__ryuBrowserActivity")).toBeUndefined();
		expect(call({ capability: "guess" })).toBeUndefined();
		expect(call({ action: "sign" })).toBeUndefined();
		expect(client.calls).toEqual([]);
		expect(contents.settlements()).toEqual([]);
	});

	it("refuses locally invalid requests without calling Core", async () => {
		const { call, client, contents } = await fixture();
		contents.url = "http://accounts.example.com/login";
		await call();
		await call({ options: { challenge: "short" }, requestId: 2 });
		contents.url = "https://accounts.example.com/login";
		await call({
			options: { challenge: CHALLENGE, rpId: "bank.test" },
			requestId: 3,
		});
		expect(client.calls).toEqual([]);
		expect(
			contents.settlements().map((s) => [s.requestId, s.settlement])
		).toEqual([
			[
				1,
				{
					error: {
						message: expect.stringContaining("https"),
						name: "SecurityError",
					},
					ok: false,
				},
			],
			[
				2,
				{
					error: {
						message: expect.stringContaining("challenge"),
						name: "TypeError",
					},
					ok: false,
				},
			],
			[
				3,
				{
					error: {
						message: expect.stringContaining("relying party"),
						name: "SecurityError",
					},
					ok: false,
				},
			],
		]);
	});

	it("allows one ceremony per tab and refuses a second while it waits", async () => {
		const { bridge, call, client, contents } = await fixture();
		const first = call();
		await call({ requestId: 2 });
		expect(bridge.busy).toBe(true);
		expect(client.calls.length).toBe(1);
		expect(contents.settlements()[0]?.requestId).toBe(2);
		expect(contents.settlements()[0]?.settlement).toMatchObject({
			error: { name: "NotAllowedError" },
			ok: false,
		});
		client.answer({ status: "timeout" });
		await first;
		expect(bridge.busy).toBe(false);
		expect(contents.settlements()[1]).toMatchObject({
			requestId: 1,
			settlement: {
				error: {
					message: "The security key request timed out.",
					name: "NotAllowedError",
				},
			},
		});
	});

	it("cancels on top-frame navigation but not on a subframe navigation", async () => {
		const { bridge, call, client, contents } = await fixture();
		const done = call();
		bridge.handleMessage("Page.frameNavigated", {
			frame: { id: "child", parentId: "top" },
		});
		expect(client.calls[0]?.signal?.aborted).toBe(false);
		bridge.handleMessage("Page.frameNavigated", { frame: { id: "top" } });
		expect(client.calls[0]?.signal?.aborted).toBe(true);
		await done;
		expect(bridge.busy).toBe(false);
		expect(contents.settlements()).toEqual([]);
	});

	it("cancels when the page aborts, the context goes away, or the tab closes", async () => {
		const { bridge, call, client, contents } = await fixture();
		const aborted = call();
		bridge.handleMessage("Runtime.bindingCalled", {
			executionContextId: 1,
			name: "__ryuWebAuthn",
			payload: JSON.stringify({
				action: "cancel",
				capability: CAPABILITY,
				requestId: 1,
			}),
		});
		await aborted;
		expect(client.calls[0]?.signal?.aborted).toBe(true);
		const destroyed = call({ requestId: 2 });
		bridge.handleMessage("Runtime.executionContextDestroyed", {
			executionContextId: 1,
		});
		await destroyed;
		expect(client.calls[1]?.signal?.aborted).toBe(true);
		bridge.handleMessage("Runtime.executionContextCreated", {
			context: { auxData: { frameId: "top", isDefault: true }, id: 5 },
		});
		const closed = call({ requestId: 3 }, 5);
		contents.destroy();
		await closed;
		expect(client.calls[2]?.signal?.aborted).toBe(true);
		expect(contents.listeners).toEqual([]);
		expect(contents.settlements()).toEqual([]);
		expect(call({ requestId: 4 }, 5)).toBeUndefined();
	});

	it("drops a reply when the tab moved to another page meanwhile", async () => {
		const { call, client, contents } = await fixture();
		const done = call();
		contents.url = "https://accounts.example.com/next";
		client.answer(OK_ASSERTION);
		await done;
		expect(contents.settlements()).toEqual([]);
	});

	it("falls back to native WebAuthn when disabled on the visible lane only", async () => {
		const visible = await fixture(null);
		const visibleDone = visible.call();
		visible.client.answer({ status: "disabled" });
		await visibleDone;
		expect(visible.contents.settlements()[0]?.settlement).toEqual({
			fallback: true,
		});
		const bot = await fixture("agent-1");
		const botDone = bot.call();
		bot.client.answer({ status: "disabled" });
		await botDone;
		expect(bot.contents.settlements()[0]?.settlement).toMatchObject({
			error: { name: "NotAllowedError" },
			ok: false,
		});
	});
});

describe("settlementFor", () => {
	const prepared = prepareRelay({
		agentId: null,
		kind: "get",
		options: { challenge: CHALLENGE },
		pageUrl: "https://example.com/",
	});

	it("refuses denied, invalid and mismatched credentials with NotAllowedError", () => {
		for (const outcome of [
			{ reason: "no", status: "denied" },
			{ message: "bad", status: "invalid" },
			{ status: "timeout" },
		] satisfies RelayOutcome[]) {
			expect(settlementFor(outcome, "get", prepared, true)).toMatchObject({
				error: { name: "NotAllowedError" },
				ok: false,
			});
		}
		expect(settlementFor(OK_ASSERTION, "create", prepared, true)).toMatchObject(
			{ ok: false }
		);
		expect(
			settlementFor(
				{
					credential: {
						id: "AQ",
						response: {
							attestation_object: "oA",
							kind: "attestation",
							transports: [],
						},
					},
					status: "ok",
				},
				"get",
				prepared,
				true
			)
		).toMatchObject({ ok: false });
	});

	it("passes an attestation through, reading what it can of the object", () => {
		expect(
			settlementFor(
				{
					credential: {
						id: "AQ",
						response: {
							attestation_object: "oA",
							kind: "attestation",
							transports: ["usb"],
						},
					},
					status: "ok",
				},
				"create",
				prepared,
				false
			)
		).toEqual({
			credential: {
				clientDataJSON: prepared.clientDataJSON,
				id: "AQ",
				response: {
					attestationObject: "oA",
					kind: "attestation",
					transports: ["usb"],
				},
			},
			ok: true,
		});
	});
});
