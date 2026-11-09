import { describe, expect, it } from "bun:test";
import {
	BotLiveViews,
	type LiveViewImage,
	type LiveViewSource,
} from "./bot-live-view.ts";
import { handleRequest } from "./control.ts";
import {
	handleLiveViewRoute,
	type LiveViewDeps,
	type LiveViewLanes,
	laneLiveViewDeps,
} from "./control-live-view.ts";
import type { RequestDeps } from "./control-parsing.ts";
import type { TabInfo, TabManager } from "./tab-manager.ts";

class StillSource implements LiveViewSource {
	readonly sent: string[] = [];
	capture(): Promise<LiveViewImage | null> {
		return Promise.resolve({ height: 10, image: "still", width: 20 });
	}
	onMessage(): () => void {
		return () => undefined;
	}
	send(method: string): Promise<unknown> {
		this.sent.push(method);
		return Promise.resolve({});
	}
}

const LANE_TABS: TabInfo[] = [
	{ id: "t1", title: "Inbox", url: "https://mail.example.com/" },
];

function fakeLanes(sources = new Map<string, StillSource>()): LiveViewLanes {
	return {
		lanes: () => [{ agentId: "agent-a", tabs: LANE_TABS }],
		liveViewSource: (agentId, tabId) => {
			if (agentId !== "agent-a" || !LANE_TABS.some((t) => t.id === tabId)) {
				return null;
			}
			const existing = sources.get(tabId) ?? new StillSource();
			sources.set(tabId, existing);
			return existing;
		},
	};
}

function deps(
	views = new BotLiveViews({ frameWaitMs: 1 }),
	lanes: LiveViewLanes | null = fakeLanes()
): LiveViewDeps {
	return laneLiveViewDeps(() => lanes, views);
}

describe("handleLiveViewRoute", () => {
	it("ignores every other path", async () => {
		expect(await handleLiveViewRoute("GET", "/tabs", undefined, deps())).toBe(
			null
		);
		expect(await handleLiveViewRoute("GET", "/lanesx", undefined, deps())).toBe(
			null
		);
	});

	it("lists open lanes and their tabs for the owner", async () => {
		const reply = await handleLiveViewRoute("GET", "/lanes", undefined, deps());
		expect(reply).toEqual({
			status: 200,
			json: { lanes: [{ agent_id: "agent-a", tabs: LANE_TABS }] },
		});
		const none = await handleLiveViewRoute(
			"GET",
			"/lanes",
			undefined,
			deps(undefined, null)
		);
		expect(none?.json).toEqual({ lanes: [] });
	});

	it("never lets an agent lane view Bot lanes", async () => {
		for (const path of ["/lanes", "/lanes/agent-a/tabs/t1/screencast"]) {
			const reply = await handleLiveViewRoute("GET", path, "agent-b", deps());
			expect(reply?.status).toBe(403);
		}
	});

	it("serves a frame of a lane tab and stops it on DELETE", async () => {
		const sources = new Map<string, StillSource>();
		const views = new BotLiveViews({ frameWaitMs: 1 });
		const routeDeps = deps(views, fakeLanes(sources));
		const reply = await handleLiveViewRoute(
			"GET",
			"/lanes/agent-a/tabs/t1/screencast",
			undefined,
			routeDeps
		);
		expect(reply?.status).toBe(200);
		expect(reply?.json).toMatchObject({
			ok: true,
			frame: { image: "still", mime: "image/jpeg", seq: 1 },
		});
		expect(sources.get("t1")?.sent).toContain("Page.startScreencast");
		const stopped = await handleLiveViewRoute(
			"DELETE",
			"/lanes/agent-a/tabs/t1/screencast",
			undefined,
			routeDeps
		);
		expect(stopped?.json).toEqual({ ok: true, stopped: true });
		expect(views.size).toBe(0);
	});

	it("404s an unknown lane or tab without starting a view", async () => {
		const views = new BotLiveViews({ frameWaitMs: 1 });
		for (const path of [
			"/lanes/agent-z/tabs/t1/screencast",
			"/lanes/agent-a/tabs/gone/screencast",
			"/lanes/%E0%A4%A/tabs/t1/screencast",
			"/lanes/agent-a/tabs/t1",
		]) {
			const reply = await handleLiveViewRoute(
				"GET",
				path,
				undefined,
				deps(views)
			);
			expect(reply?.status).toBe(404);
		}
		expect(views.size).toBe(0);
	});

	it("answers 429 when too many views are open", async () => {
		const views = new BotLiveViews({ frameWaitMs: 1, maxViews: 0 });
		const reply = await handleLiveViewRoute(
			"GET",
			"/lanes/agent-a/tabs/t1/screencast",
			undefined,
			deps(views)
		);
		expect(reply?.status).toBe(429);
	});

	it("reports a view that cannot start without detail", async () => {
		const failing: LiveViewLanes = {
			lanes: () => [],
			liveViewSource: () => ({
				capture: () => Promise.resolve(null),
				onMessage: () => () => undefined,
				send: () => Promise.reject(new Error("secret debugger detail")),
			}),
		};
		const reply = await handleLiveViewRoute(
			"GET",
			"/lanes/agent-a/tabs/t1/screencast",
			undefined,
			deps(undefined, failing)
		);
		expect(reply?.status).toBe(502);
		expect(JSON.stringify(reply?.json)).not.toContain("secret");
	});
});

describe("handleRequest live view", () => {
	const visibleTabs = {
		list: () => [],
	} as unknown as TabManager;

	function requestDeps(overrides: Partial<RequestDeps> = {}): RequestDeps {
		return {
			liveView: deps(),
			tabs: visibleTabs,
			tabsFor: () => {
				throw new Error("a live-view request must not open a Bot lane");
			},
			token: "secret",
			...overrides,
		};
	}

	it("requires the bearer", async () => {
		const reply = await handleRequest(
			"GET",
			"/lanes",
			undefined,
			"",
			requestDeps()
		);
		expect(reply.status).toBe(401);
	});

	it("honours the browser control setting", async () => {
		const reply = await handleRequest(
			"GET",
			"/lanes",
			"Bearer secret",
			"",
			requestDeps({ controlEnabled: () => false })
		);
		expect(reply.status).toBe(403);
	});

	it("refuses an agent lane before resolving any lane", async () => {
		const reply = await handleRequest(
			"GET",
			"/lanes/agent-a/tabs/t1/screencast",
			"Bearer secret",
			"",
			requestDeps(),
			undefined,
			"agent-b"
		);
		expect(reply.status).toBe(403);
	});

	it("serves the owner's lane list", async () => {
		const reply = await handleRequest(
			"GET",
			"/lanes",
			"Bearer secret",
			"",
			requestDeps()
		);
		expect(reply).toEqual({
			status: 200,
			json: { lanes: [{ agent_id: "agent-a", tabs: LANE_TABS }] },
		});
	});
});
