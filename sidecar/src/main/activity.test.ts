import { describe, expect, it } from "bun:test";
import { BrowserActivityStore } from "./activity.ts";

const tab = {
	kind: "audio" as const,
	selectable: true,
	tabId: "tab-1",
	tabTitle: "Music",
	tabUrl: "https://example.test/music",
};

describe("browser activity store", () => {
	it("keeps active tab activity addressable and updates its tab metadata", () => {
		const store = new BrowserActivityStore();
		store.setTabActivity(tab, true, 1000);
		store.updateTab("tab-1", {
			title: "Updated music",
			url: "https://example.test/next",
		});

		expect(store.snapshot(1100)).toMatchObject([
			{
				kind: "audio",
				status: "active",
				tabTitle: "Updated music",
				tabUrl: "https://example.test/next",
			},
		]);
	});

	it("keeps a stopped activity briefly as recent, then removes it", () => {
		const store = new BrowserActivityStore();
		store.setTabActivity({ ...tab, kind: "microphone" }, true, 1000);
		store.setTabActivity({ ...tab, kind: "microphone" }, false, 2000);

		expect(store.snapshot(2001)[0]?.status).toBe("recent");
		expect(store.snapshot(17_001)).toEqual([]);
	});

	it("expires computer-use activity without persisting it", () => {
		const store = new BrowserActivityStore();
		store.startComputerUse(
			{
				agentId: "agent-1",
				agentLabel: "Ryu",
				selectable: false,
				tabId: "tab-1",
				tabTitle: "Docs",
			},
			1000
		);

		expect(store.snapshot(8999)[0]?.status).toBe("active");
		expect(store.snapshot(9000)[0]?.status).toBe("recent");
		expect(store.snapshot(24_001)).toEqual([]);
	});
});
