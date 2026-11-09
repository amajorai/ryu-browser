import { describe, expect, it } from "bun:test";
import { handleRequest } from "./control.ts";
import { runFillCredential } from "./control-credentials.ts";
import { laneSessionId } from "./lane-session.ts";
import type { TabManager } from "./tab-manager.ts";
import type { CredentialFillRequest, VaultClient } from "./vault-fill.ts";

/** A lane whose fill resolves the value for one page and records it. */
function fillingLane(pageUrl: string): { lane: TabManager; values: string[] } {
	const values: string[] = [];
	const lane = {
		activeId: () => "t",
		list: () => [{ id: "t", title: "", url: pageUrl }],
		fillCredential: async (
			_tabId: string,
			_ref: string,
			_field: string,
			resolve: (url: string) => Promise<string>
		) => {
			values.push(await resolve(pageUrl));
			return { tab: { id: "t", title: "", url: pageUrl } };
		},
	} as unknown as TabManager;
	return { lane, values };
}

function recordingVault(): {
	requests: CredentialFillRequest[];
	vault: VaultClient;
} {
	const requests: CredentialFillRequest[] = [];
	return {
		requests,
		vault: {
			credentialFill: (request) => {
				requests.push(request);
				return Promise.resolve("value-never-echoed");
			},
			totpEnroll: () => Promise.resolve(),
		},
	};
}

describe("lane browser session ids", () => {
	it("are stable per lane and distinct across lanes", () => {
		const first = {};
		const second = {};
		expect(laneSessionId(first)).toBe(laneSessionId(first));
		expect(laneSessionId(first)).not.toBe(laneSessionId(second));
		expect(laneSessionId(first)).toMatch(/^bs_[0-9a-f-]{36}$/);
	});

	it("ride a credential fill to Core and never come back in the reply", async () => {
		const { lane, values } = fillingLane("https://github.com/login");
		const { requests, vault } = recordingVault();
		const reply = await runFillCredential(
			lane,
			"t",
			{ account: "attached:1", field: "password", ref: "@e2" },
			{ agentId: "bot", browserSession: laneSessionId(lane), vault }
		);
		expect(reply.status).toBe(200);
		expect(values).toEqual(["value-never-echoed"]);
		expect(JSON.stringify(reply.json)).not.toContain("value-never-echoed");
		expect(requests).toEqual([
			{
				account: "attached:1",
				agent_id: "bot",
				browser_session: laneSessionId(lane),
				field: "password",
				page_url: "https://github.com/login",
			},
		]);
	});

	it("are stamped by the sidecar on agent lanes only", async () => {
		const call = async (agentId: string | undefined, payload: object) => {
			const { lane } = fillingLane("https://github.com/login");
			const { requests, vault } = recordingVault();
			const reply = await handleRequest(
				"POST",
				"/fill-credential",
				"Bearer tok",
				JSON.stringify(payload),
				{ tabs: lane, tabsFor: () => lane, token: "tok", vault },
				"application/json",
				agentId
			);
			return { lane, reply, requests };
		};
		const body = { account: "attached:1", field: "password", ref: "@e2" };
		const agent = await call("bot", { ...body, browser_session: "forged" });
		expect(agent.reply.status).toBe(200);
		expect(agent.requests[0]?.browser_session).toBe(laneSessionId(agent.lane));
		const user = await call(undefined, body);
		expect(user.reply.status).toBe(200);
		expect(user.requests[0]?.browser_session).toBeUndefined();
	});

	it("are left off an agent's own account fill, keeping the old wire shape", async () => {
		const { lane } = fillingLane("https://github.com/login");
		const { requests, vault } = recordingVault();
		const reply = await handleRequest(
			"POST",
			"/fill-credential",
			"Bearer tok",
			JSON.stringify({ account: "acc_1", field: "password", ref: "@e2" }),
			{ tabs: lane, tabsFor: () => lane, token: "tok", vault },
			"application/json",
			"bot"
		);
		expect(reply.status).toBe(200);
		expect(requests).toEqual([
			{
				account: "acc_1",
				agent_id: "bot",
				field: "password",
				page_url: "https://github.com/login",
			},
		]);
		expect(Object.keys(requests[0] ?? {})).not.toContain("browser_session");
	});
});
