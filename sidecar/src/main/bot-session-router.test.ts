import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "electron";
import type { FakeWebContentsView } from "./__tests__/electron-fake.ts";
import {
	electronFakeState,
	type FakeSession,
	installElectronFake,
	resetElectronFake,
} from "./__tests__/electron-fake.ts";
import type { BotLaneNetwork } from "./bot-session-router.ts";
import type { TabManager } from "./tab-manager.ts";

installElectronFake();
const { BrowserActivityStore } = await import("./activity.ts");
const { botSessionPartition, LEGACY_SHARED_BOT_PARTITION } = await import(
	"./bot-partition.ts"
);
const { EgressAllowlistError } = await import("./egress-allowlist.ts");
const {
	BrowserSessionRouter,
	MAX_BOT_BROWSER_SESSIONS,
	normalizeBrowserAgentId,
	routeThroughNetworkGuard,
} = await import("./bot-session-router.ts");

interface LaneProxy {
	allows: (host: string) => boolean;
	closed: boolean;
	port: number;
}

function laneNetwork(overrides: Partial<BotLaneNetwork> = {}) {
	const guarded: string[] = [];
	const proxies: LaneProxy[] = [];
	const network: BotLaneNetwork = {
		assertNoBypass: () => undefined,
		route: (browserSession: Session, port: number) => {
			guarded.push(
				`${(browserSession as unknown as FakeSession).partition}@${port}`
			);
			return Promise.resolve();
		},
		startProxy: (allows) => {
			const proxy: LaneProxy = {
				allows,
				closed: false,
				port: 4000 + proxies.length,
			};
			proxies.push(proxy);
			return Promise.resolve({
				close: () => {
					proxy.closed = true;
				},
				port: proxy.port,
			});
		},
		...overrides,
	};
	return { guarded, network, proxies };
}

function routerFixture(overrides: Partial<BotLaneNetwork> = {}) {
	const lanes = laneNetwork(overrides);
	const router = new BrowserSessionRouter(
		new BrowserActivityStore(),
		() => undefined,
		lanes.network
	);
	return { ...lanes, router };
}

function partition(name: string): FakeSession {
	const found = electronFakeState.partitions.get(name);
	if (!found) {
		throw new Error(`partition ${name} was never opened`);
	}
	return found;
}

describe("BrowserSessionRouter", () => {
	beforeEach(() => resetElectronFake());

	it("gives each agent its own guarded partition, reused per agent", async () => {
		const { guarded, router } = routerFixture();
		const first = await router.tabsFor("agent-a");
		const again = await router.tabsFor("agent-a");
		const other = await router.tabsFor("agent-b");
		expect(first).not.toBeNull();
		expect(again).toBe(first);
		expect(other).not.toBe(first);
		expect(guarded).toEqual([
			`${botSessionPartition("agent-a")}@4000`,
			`${botSessionPartition("agent-b")}@4001`,
		]);
		const botSession = partition(botSessionPartition("agent-a"));
		expect(botSession.downloadPath).toContain("downloads");
		expect(botSession.requestListener).not.toBeNull();
	});

	it("refuses blank or control-character ids and stops after closeAll", async () => {
		const { router } = routerFixture();
		expect(await router.tabsFor("  ")).toBeNull();
		expect(await router.tabsFor("a\u0007b")).toBeNull();
		expect(normalizeBrowserAgentId(" agent ")).toBe("agent");
		router.closeAll();
		expect(await router.tabsFor("agent-a")).toBeNull();
	});

	it("fails closed when the network guard cannot be installed", async () => {
		const { proxies, router } = routerFixture({
			route: () => Promise.reject(new Error("guard down")),
		});
		expect(await router.tabsFor("agent-a")).toBeNull();
		expect(proxies.map((proxy) => proxy.closed)).toEqual([true]);
	});

	it("caps the number of Bot sessions", async () => {
		const { router } = routerFixture();
		for (let index = 0; index < MAX_BOT_BROWSER_SESSIONS; index += 1) {
			expect(await router.tabsFor(`agent-${index}`)).not.toBeNull();
		}
		expect(await router.tabsFor("one-too-many")).toBeNull();
	});

	it("clears the legacy shared jar once and removes the shared state file", async () => {
		const root = join(electronFakeState.userData, "managed-bots");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "browser-state.json"), "{}");
		routerFixture();
		await Promise.resolve();
		await Promise.resolve();
		expect(existsSync(join(root, "browser-state.json"))).toBe(false);
		expect(partition(LEGACY_SHARED_BOT_PARTITION).cleared).toBe(true);
	});

	it("verifies Chromium reports the guard proxy before any page loads", async () => {
		const { FakeSession: Fake } = await import("./__tests__/electron-fake.ts");
		const good = new Fake("good");
		await routeThroughNetworkGuard(good as unknown as Session, 4100);
		expect(good.proxyRules).toBe("socks5://127.0.0.1:4100");
		const bad = new Fake("bad");
		bad.reportedProxy = "DIRECT";
		await expect(
			routeThroughNetworkGuard(bad as unknown as Session, 4100)
		).rejects.toThrow("not active");
	});
});

describe("BrowserSessionRouter egress", () => {
	beforeEach(() => resetElectronFake());

	it("enforces Core's lane allowlist on that lane's proxy and requests only", async () => {
		const { proxies, router } = routerFixture();
		expect(
			await router.tabsFor("agent-a", "example.com, *.cdn.example.net")
		).not.toBeNull();
		expect(await router.tabsFor("agent-b")).not.toBeNull();
		const [laneA, laneB] = proxies;
		expect(laneA?.allows("example.com")).toBe(true);
		expect(laneA?.allows("img.cdn.example.net")).toBe(true);
		expect(laneA?.allows("tracker.test")).toBe(false);
		expect(laneB?.allows("tracker.test")).toBe(true);

		const listener = partition(botSessionPartition("agent-a")).requestListener;
		const cancelled = (url: string) =>
			new Promise<boolean>((resolve) => {
				listener?.({ resourceType: "image", url }, ({ cancel }) =>
					resolve(cancel)
				);
			});
		expect(await cancelled("https://tracker.test/pixel.gif")).toBe(true);
		expect(await cancelled("wss://tracker.test/socket")).toBe(true);
		expect(await cancelled("https://example.com/logo.png")).toBe(false);
	});

	it("lets a later request narrow the allowlist but never widen it", async () => {
		const { proxies, router } = routerFixture();
		await router.tabsFor("agent-a", "*.example.com");
		expect(() => router.tabsFor("agent-a", "*.example.com,other.test")).toThrow(
			EgressAllowlistError
		);
		expect(await router.tabsFor("agent-a")).not.toBeNull();
		await router.tabsFor("agent-a", "www.example.com");
		expect(proxies[0]?.allows("api.example.com")).toBe(false);
		expect(proxies[0]?.allows("www.example.com")).toBe(true);
		expect(() => router.tabsFor("agent-c", "https://example.com/")).toThrow(
			EgressAllowlistError
		);
	});

	it("keeps Bot lanes closed while Chromium can bypass the proxy", async () => {
		const { proxies, router } = routerFixture({
			assertNoBypass: () => {
				throw new Error("no-proxy-server");
			},
		});
		expect(await router.tabsFor("agent-a")).toBeNull();
		expect(proxies).toEqual([]);
	});

	it("pins WebRTC in Bot tabs and closes lane proxies on shutdown", async () => {
		const { proxies, router } = routerFixture();
		const tabs = (await router.tabsFor("agent-a")) as TabManager;
		tabs.open("https://example.com/");
		const views = Reflect.get(tabs, "tabs") as { view: FakeWebContentsView }[];
		expect(views[0]?.view.webContents.webRtcPolicy).toBe(
			"disable_non_proxied_udp"
		);
		router.closeAll();
		expect(proxies.map((proxy) => proxy.closed)).toEqual([true]);
	});

	it("lists open lanes for the live view without creating one", async () => {
		const { router } = routerFixture();
		expect(router.lanes()).toEqual([]);
		expect(router.liveViewSource("agent-a", "t1")).toBeNull();
		expect(router.lanes()).toEqual([]);
		const tabs = (await router.tabsFor("agent-a")) as TabManager;
		const tab = tabs.open("https://example.com/");
		expect(router.lanes()).toEqual([{ agentId: "agent-a", tabs: [tab] }]);
		expect(router.liveViewSource(" agent-a ", tab.id)).not.toBeNull();
		expect(router.liveViewSource("agent-a", "missing")).toBeNull();
		expect(router.liveViewSource("agent-b", tab.id)).toBeNull();
		tabs.close(tab.id);
		expect(router.liveViewSource("agent-a", tab.id)).toBeNull();
	});
});

describe("BrowserSessionRouter profiles", () => {
	beforeEach(() => resetElectronFake());

	it("closes a lane's tabs and window but keeps its profile", async () => {
		const { router } = routerFixture();
		const tabs = await router.tabsFor("agent-a");
		tabs?.open("about:blank");
		const id = botSessionPartition("agent-a").slice("persist:".length);
		expect([...router.openProfiles().keys()]).toEqual([id]);
		expect(router.closeLane("agent-a")).toBe(true);
		expect(router.closeLane("agent-a")).toBe(false);
		expect(router.openProfiles().size).toBe(0);
		expect(tabs?.list()).toEqual([]);
		expect(
			existsSync(join(router.managedBotsRoot(), "agents", id, "downloads"))
		).toBe(true);
		const reopened = await router.tabsFor("agent-a");
		expect(reopened).not.toBe(tabs);
	});

	it("deletes a profile: clears its partition and empties its state", async () => {
		const { router } = routerFixture();
		const tabs = await router.tabsFor("agent-a");
		const id = botSessionPartition("agent-a").slice("persist:".length);
		const botSession = partition(botSessionPartition("agent-a"));
		botSession.cookieJar = [{ domain: "a.example", name: "sid", value: "v" }];
		tabs?.open("https://a.example/");
		expect(await router.profileCookies(id)).toHaveLength(1);
		expect(await router.deleteProfile(id)).toBe(true);
		expect(botSession.cleared).toBe(true);
		expect(await router.profileCookies(id)).toEqual([]);
		expect(router.openProfiles().size).toBe(0);
		const stateFile = join(
			router.managedBotsRoot(),
			"agents",
			id,
			"browser-state.json"
		);
		expect(existsSync(stateFile)).toBe(true);
		expect(JSON.parse(readFileSync(stateFile, "utf8")).history).toEqual([]);
	});

	it("opens no lane on a profile while its delete is still clearing it", async () => {
		const { router } = routerFixture();
		await router.tabsFor("agent-a");
		const id = botSessionPartition("agent-a").slice("persist:".length);
		const botSession = partition(botSessionPartition("agent-a"));
		botSession.cookieJar = [{ domain: "a.example", name: "sid", value: "v" }];
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const clear = botSession.clearStorageData.bind(botSession);
		botSession.clearStorageData = async () => {
			await gate;
			await clear();
		};
		const deleting = router.deleteProfile(id);
		expect(await router.tabsFor("agent-a")).toBeNull();
		expect(router.openProfiles().size).toBe(0);
		expect(await router.deleteProfile(id)).toBe(false);
		release();
		expect(await deleting).toBe(true);
		expect(router.openProfiles().size).toBe(0);
		expect(await router.profileCookies(id)).toEqual([]);
		expect(await router.tabsFor("agent-a")).not.toBeNull();
	});

	it("deletes a profile left on disk by an earlier run, and refuses bad ids", async () => {
		const { router } = routerFixture();
		const id = botSessionPartition("old-agent").slice("persist:".length);
		const folder = join(router.managedBotsRoot(), "agents", id);
		mkdirSync(folder, { recursive: true });
		expect(await router.deleteProfile(id)).toBe(true);
		expect(existsSync(folder)).toBe(false);
		expect(await router.deleteProfile(id)).toBe(false);
		expect(await router.deleteProfile("../escape")).toBe(false);
		expect(await router.profileCookies("../escape")).toEqual([]);
	});
});
