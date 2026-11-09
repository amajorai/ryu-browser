import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileIdFor } from "./bot-profiles.ts";
import { handleRequest } from "./control.ts";
import { handleProfileRoute, type ProfileLanes } from "./control-profiles.ts";
import { laneSessionId } from "./lane-session.ts";
import type { TabManager } from "./tab-manager.ts";

const TOKEN = "profile-token";
const AUTH = `Bearer ${TOKEN}`;

function fakeTabs(urls: string[]): TabManager {
	const tabs = urls.map((url, index) => ({ id: `t${index}`, title: "", url }));
	return {
		close: (id: string) => {
			const index = tabs.findIndex((tab) => tab.id === id);
			if (index >= 0) {
				tabs.splice(index, 1);
			}
			return index >= 0;
		},
		list: () => [...tabs],
	} as unknown as TabManager;
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ryu-control-profiles-"));
	const openId = profileIdFor("agent-a");
	const closedId = profileIdFor("agent-b");
	for (const id of [openId, closedId]) {
		mkdirSync(join(root, "agents", id), { recursive: true });
	}
	writeFileSync(
		join(root, "agents", closedId, "browser-state.json"),
		JSON.stringify({
			history: [
				{ id: "h", title: "B", url: "https://b.example/", visitedAt: 1 },
			],
		})
	);
	const tabsA = fakeTabs(["https://a.example/"]);
	const tabsB = fakeTabs([]);
	const open = new Map([[openId, { agentId: "agent-a", tabs: tabsA }]]);
	const deleted: string[] = [];
	const lanes: ProfileLanes = {
		closeLane: (agentId) => {
			const entry = [...open].find(([, lane]) => lane.agentId === agentId);
			if (!entry) {
				return false;
			}
			open.delete(entry[0]);
			return true;
		},
		deleteProfile: (id) => {
			deleted.push(id);
			return Promise.resolve(id === closedId || id === openId);
		},
		managedBotsRoot: () => root,
		openProfiles: () => new Map(open),
		profileCookies: () =>
			Promise.resolve([
				{ domain: "b.example", name: "sid", value: "LIVE-COOKIE-VALUE" },
			]),
	};
	return { closedId, deleted, lanes, open, openId, tabsA, tabsB };
}

describe("profile routes", () => {
	it("lists every profile on disk with its open lane's session", async () => {
		const { closedId, lanes, openId, tabsA } = fixture();
		const reply = await handleProfileRoute(
			"GET",
			"/profiles",
			undefined,
			() => lanes
		);
		const profiles = (reply?.json as { profiles: Record<string, unknown>[] })
			.profiles;
		const byId = new Map(profiles.map((profile) => [profile.id, profile]));
		expect(byId.get(openId)).toMatchObject({
			agent_id: "agent-a",
			browser_session: laneSessionId(tabsA),
			open: true,
			tabs: 1,
		});
		expect(byId.get(closedId)).toMatchObject({
			agent_id: null,
			browser_session: null,
			history_entries: 1,
			open: false,
		});
	});

	it("refuses every profile route to an agent lane", async () => {
		const { lanes, openId } = fixture();
		for (const [method, path] of [
			["GET", "/profiles"],
			["DELETE", `/profiles/${openId}`],
			["GET", `/profiles/${openId}/export`],
		]) {
			const reply = await handleProfileRoute(
				method,
				path,
				"agent-a",
				() => lanes
			);
			expect(reply?.status).toBe(403);
		}
	});

	it("exports reviewable state without any cookie value", async () => {
		const { closedId, lanes } = fixture();
		const reply = await handleProfileRoute(
			"GET",
			`/profiles/${closedId}/export`,
			undefined,
			() => lanes
		);
		expect(reply?.status).toBe(200);
		expect(JSON.stringify(reply?.json)).not.toContain("LIVE-COOKIE-VALUE");
		expect(reply?.json).toMatchObject({
			cookies: [{ domain: "b.example", name: "sid" }],
			history: [{ url: "https://b.example/" }],
			id: closedId,
		});
	});

	it("deletes a known profile and 404s an unknown or malformed id", async () => {
		const { closedId, deleted, lanes } = fixture();
		const ok = await handleProfileRoute(
			"DELETE",
			`/profiles/${closedId}`,
			undefined,
			() => lanes
		);
		expect(ok).toMatchObject({ json: { deleted: closedId }, status: 200 });
		const malformed = await handleProfileRoute(
			"DELETE",
			"/profiles/..%2Fsecrets",
			undefined,
			() => lanes
		);
		expect(malformed?.status).toBe(404);
		const unknown = await handleProfileRoute(
			"GET",
			`/profiles/${profileIdFor("nobody")}/export`,
			undefined,
			() => lanes
		);
		expect(unknown?.status).toBe(404);
		expect(deleted).toEqual([closedId]);
	});
});

describe("session routes", () => {
	it("shows an agent only its own lane session", async () => {
		const { lanes, tabsA } = fixture();
		const own = await handleProfileRoute(
			"GET",
			"/sessions",
			"agent-a",
			() => lanes
		);
		expect(own?.json).toEqual({
			sessions: [
				{
					agent_id: "agent-a",
					id: laneSessionId(tabsA),
					profile: profileIdFor("agent-a"),
					tabs: [{ id: "t0", title: "", url: "https://a.example/" }],
				},
			],
		});
		const other = await handleProfileRoute(
			"GET",
			"/sessions",
			"agent-b",
			() => lanes
		);
		expect(other?.json).toEqual({ sessions: [] });
	});

	it("lets an agent close only its own lane, never the shared session", async () => {
		const { lanes, open } = fixture();
		const owner = await handleProfileRoute(
			"DELETE",
			"/sessions/current",
			undefined,
			() => lanes
		);
		expect(owner?.status).toBe(400);
		const closed = await handleProfileRoute(
			"DELETE",
			"/sessions/current",
			"agent-a",
			() => lanes
		);
		expect(closed?.json).toEqual({ closed: true, ok: true });
		expect(open.size).toBe(0);
	});

	it("answers through the control router without opening a lane", async () => {
		const { lanes } = fixture();
		let opened = 0;
		const reply = await handleRequest(
			"GET",
			"/sessions",
			AUTH,
			"",
			{
				profileLanes: () => lanes,
				tabs: fakeTabs([]),
				tabsFor: () => {
					opened += 1;
					return null;
				},
				token: TOKEN,
			},
			undefined,
			"agent-new"
		);
		expect(reply).toMatchObject({ json: { sessions: [] }, status: 200 });
		expect(opened).toBe(0);
		const unauthorized = await handleRequest(
			"GET",
			"/profiles",
			undefined,
			"",
			{
				profileLanes: () => lanes,
				tabs: fakeTabs([]),
				token: TOKEN,
			}
		);
		expect(unauthorized.status).toBe(401);
	});
});
