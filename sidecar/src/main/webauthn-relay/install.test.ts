import { describe, expect, it } from "bun:test";
import type { RelayContents } from "./bridge.ts";
import type { SecurityKeyClient } from "./client.ts";
import { installWebAuthnRelay } from "./install.ts";
import type { RelayRequest } from "./request.ts";

function contents(fail = false) {
	const methods: string[] = [];
	const target: RelayContents & { methods: string[]; url: string } = {
		debugger: {
			on: () => undefined,
			removeListener: () => undefined,
			sendCommand: (method) => {
				methods.push(method);
				if (fail && method === "Page.addScriptToEvaluateOnNewDocument") {
					return Promise.reject(new Error("target closed"));
				}
				return Promise.resolve(
					method === "Page.getFrameTree"
						? { frameTree: { frame: { id: "top" } } }
						: {}
				);
			},
		},
		getURL: () => target.url,
		isDestroyed: () => false,
		methods,
		once: () => undefined,
		url: "https://example.com/",
	};
	return target;
}

function client(seen: RelayRequest[]): SecurityKeyClient {
	return {
		request: (body) => {
			seen.push(body);
			return Promise.resolve({ status: "timeout" });
		},
	};
}

describe("installWebAuthnRelay", () => {
	it("installs nothing outside Core", async () => {
		const tab = contents();
		expect(await installWebAuthnRelay(tab, "visible", null)).toBeNull();
		expect(tab.methods).toEqual([]);
	});

	it("maps the visible lane to no agent and a Bot lane to its agent id", async () => {
		const visible = await installWebAuthnRelay(
			contents(),
			"visible",
			client([])
		);
		const bot = await installWebAuthnRelay(contents(), "agent-42", client([]));
		expect(visible?.agentId).toBeNull();
		expect(bot?.agentId).toBe("agent-42");
	});

	it("never forwards calls without the tab's private capability", async () => {
		const seen: RelayRequest[] = [];
		const tab = contents();
		const bridge = await installWebAuthnRelay(tab, "visible", client(seen));
		bridge?.handleMessage("Runtime.executionContextCreated", {
			context: { auxData: { frameId: "top", isDefault: true }, id: 1 },
		});
		await bridge?.handleMessage("Runtime.bindingCalled", {
			executionContextId: 1,
			name: "__ryuWebAuthn",
			payload: JSON.stringify({
				action: "request",
				capability: "wrong",
				kind: "get",
				options: {},
				requestId: 1,
			}),
		});
		expect(seen).toEqual([]);
		expect(tab.methods).not.toContain("Runtime.evaluate");
	});

	it("leaves the tab usable when the debugger refuses the script", async () => {
		const tab = contents(true);
		expect(await installWebAuthnRelay(tab, "visible", client([]))).toBeNull();
		expect(tab.methods.at(-1)).toBe("Page.addScriptToEvaluateOnNewDocument");
	});
});
