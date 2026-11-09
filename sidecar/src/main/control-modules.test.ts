import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { handleRequest } from "./control.ts";
import { handleControlAction, parsePoint } from "./control-actions.ts";
import { handleCapabilityBridge } from "./control-bridge.ts";
import { parseAccountId, runFillCredential } from "./control-credentials.ts";
import {
	noSuchTab,
	parseRect,
	parseSelections,
	parseThemeTokens,
} from "./control-parsing.ts";
import { startControlServer } from "./control-server.ts";
import { EgressAllowlistError } from "./egress-allowlist.ts";
import {
	agentLaneForCaller,
	blockedNavigationAddress,
	safeNavigationUrl,
} from "./navigation-safety.ts";
import type { TabInfo, TabManager } from "./tab-manager.ts";

function tabsWith(tabs: TabInfo[]): TabManager {
	const opened: string[] = [];
	return {
		activeId: () => tabs[0]?.id ?? null,
		list: () => tabs,
		open: (url: string) => {
			opened.push(url);
			return { id: "new", title: "", url };
		},
	} as unknown as TabManager;
}

describe("navigation safety", () => {
	it("blocks loopback and private destinations", () => {
		expect(blockedNavigationAddress("127.0.0.1")).toBe(true);
		expect(blockedNavigationAddress("10.1.2.3")).toBe(true);
		expect(blockedNavigationAddress("93.184.215.14")).toBe(false);
		expect(() => safeNavigationUrl("http://localhost/")).toThrow();
	});

	it("takes a Bot lane only from Core's stamped caller", () => {
		expect(agentLaneForCaller("bot-a", undefined)).toBeUndefined();
		expect(agentLaneForCaller(undefined, " bot-a ")).toBe("bot-a");
	});
});

describe("control parsing", () => {
	it("bounds theme tokens and geometry", () => {
		expect(
			parseThemeTokens('{"tokens":{"--accent":"red","--bad":"x;}","no":"y"}}')
		).toEqual({ "--accent": "red" });
		expect(parseThemeTokens('{"tokens":"red"}')).toBeNull();
		expect(parseRect({ height: 2, width: 3, x: 0, y: 1 })).toEqual({
			height: 2,
			width: 3,
			x: 0,
			y: 1,
		});
		expect(parseSelections("nope")).toBeNull();
		expect(noSuchTab(true).status).toBe(404);
	});
});

describe("control credentials", () => {
	it("needs an account and a vault before touching the page", async () => {
		expect(parseAccountId({ account: " acct " })).toBe("acct");
		const tabs = tabsWith([{ id: "t", title: "", url: "https://a.test/" }]);
		const missingAccount = await runFillCredential(
			tabs,
			"t",
			{ field: "password", ref: "@e1" },
			{ agentId: "bot", vault: null }
		);
		expect(missingAccount.status).toBe(400);
		const noVault = await runFillCredential(
			tabs,
			"t",
			{ account: "acct", field: "password", ref: "@e1" },
			{ agentId: "bot", vault: null }
		);
		expect(noVault.status).toBe(503);
	});
});

describe("control actions", () => {
	it("parses points and refuses unknown tabs", async () => {
		expect(parsePoint({ x: "1", y: 2 })).toEqual({ x: 1, y: 2 });
		expect(parsePoint({ x: "a", y: 2 })).toBeNull();
		const reply = await handleControlAction(
			"POST",
			"/click",
			{ tab_id: "missing" },
			tabsWith([])
		);
		expect(reply.status).toBe(404);
	});
});

describe("control capability bridge", () => {
	it("opens only validated URLs and rejects unknown verbs", async () => {
		const tabs = tabsWith([]);
		const opened = await handleCapabilityBridge(
			JSON.stringify({
				args: { url: "https://example.com/" },
				tool: "browser.navigate",
			}),
			tabs,
			(value) => value
		);
		expect(opened.status).toBe(201);
		const refused = await handleCapabilityBridge(
			JSON.stringify({ args: { url: "http://x" }, tool: "browser.navigate" }),
			tabs,
			() => {
				throw new Error("blocked host");
			}
		);
		expect(refused).toEqual({
			json: { error: "blocked host", ok: false },
			status: 400,
		});
		const unknown = await handleCapabilityBridge(
			JSON.stringify({ tool: "browser.eval" }),
			tabs,
			(value) => value
		);
		expect(unknown.status).toBe(400);
	});
});

describe("Bot lane egress allowlist", () => {
	it("hands Core's allowlist to the lane and refuses a rejected one", async () => {
		const seen: [string, string | undefined][] = [];
		const deps = {
			tabs: tabsWith([]),
			tabsFor: (agentId: string, egress?: string) => {
				seen.push([agentId, egress]);
				if (egress === "wider.test") {
					throw new EgressAllowlistError("cannot be widened");
				}
				return tabsWith([]);
			},
			token: "secret",
		};
		const ask = (egress: string) =>
			handleRequest(
				"GET",
				"/tabs",
				"Bearer secret",
				"",
				deps,
				undefined,
				"bot",
				egress
			);
		expect((await ask("example.com")).status).toBe(200);
		expect(await ask("wider.test")).toEqual({
			json: { error: "cannot be widened", ok: false },
			status: 403,
		});
		expect(seen).toEqual([
			["bot", "example.com"],
			["bot", "wider.test"],
		]);
	});
});

async function freePort(): Promise<number> {
	const probe = createServer().listen(0, "127.0.0.1");
	await once(probe, "listening");
	const { port } = probe.address() as AddressInfo;
	probe.close();
	await once(probe, "close");
	return port;
}

function getStatus(
	port: number,
	path: string,
	headers: Record<string, string>
): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const req = request({ headers, host: "127.0.0.1", path, port }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end();
	});
}

describe("control server", () => {
	it("reads the allowlist header only on a Core-stamped agent lane", async () => {
		const seen: [string, string | undefined][] = [];
		const port = await freePort();
		const server = startControlServer(
			{
				tabs: tabsWith([]),
				tabsFor: (agentId, egress) => {
					seen.push([agentId, egress]);
					return tabsWith([]);
				},
				token: "secret",
			},
			port
		);
		await once(server, "listening");
		try {
			const auth = { Authorization: "Bearer secret" };
			const allowlist = { "x-ryu-caller-egress-allowlist": "example.com" };
			expect(await getStatus(port, "/tabs", { ...auth, ...allowlist })).toBe(
				200
			);
			expect(
				await getStatus(port, "/tabs", {
					...auth,
					...allowlist,
					"x-ryu-caller-agent-id": "bot",
				})
			).toBe(200);
			expect(seen).toEqual([["bot", "example.com"]]);
		} finally {
			server.close();
		}
	});

	it("serves health and refuses browser-origin requests", async () => {
		const probe = createServer().listen(0, "127.0.0.1");
		await once(probe, "listening");
		const { port } = probe.address() as AddressInfo;
		probe.close();
		await once(probe, "close");
		const server = startControlServer(
			{ tabs: tabsWith([]), token: "secret" },
			port
		);
		await once(server, "listening");
		const get = (headers: Record<string, string>) =>
			new Promise<number>((resolve, reject) => {
				const req = request(
					{ headers, host: "127.0.0.1", path: "/health", port },
					(res) => {
						res.resume();
						resolve(res.statusCode ?? 0);
					}
				);
				req.on("error", reject);
				req.end();
			});
		try {
			expect(await get({})).toBe(200);
			expect(await get({ Origin: "https://evil.test" })).toBe(403);
		} finally {
			server.close();
		}
	});
});
