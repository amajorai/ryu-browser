import { describe, expect, it } from "bun:test";
import {
	type BrowserLegacyDownloadEntry,
	browserDownloadRecordSchema,
	browserPersistedProfileSchema,
	browserStateSchema,
	browserStoredSettingsSchema,
} from "./browser-records.ts";
import {
	type BrowserSettings,
	type BrowserState,
	defaultBrowserSettings,
	formatBytes,
} from "./browser-state.ts";

describe("native Browser state owners", () => {
	it("retains complete state, nested records and additive publisher fields", () => {
		const current: BrowserState = {
			activeId: "tab-1",
			activeTitle: "Example",
			activeUrl: "https://example.com",
			activities: [
				{
					detail: "Camera access",
					id: "tab:tab-1:camera",
					kind: "camera",
					selectable: true,
					source: "browser-tab",
					startedAt: 1,
					status: "active",
					tabId: "tab-1",
					tabTitle: "Example",
					tabUrl: "https://example.com",
					updatedAt: 2,
				},
			],
			cdpRestartRequired: false,
			deviceToolbar: false,
			downloads: [],
			extensions: [],
			history: [
				{
					id: "history-1",
					title: "Example",
					url: "https://example.com",
					visitedAt: 1,
				},
			],
			settings: defaultBrowserSettings("/Downloads"),
			surface: "browser",
			tabs: [
				{
					canGoBack: false,
					canGoForward: false,
					id: "tab-1",
					loading: false,
					title: "Example",
					url: "https://example.com",
					zoomPercent: 100,
				},
			],
		};
		const metadata = JSON.parse(
			'{"__proto__":{"native":true},"items":[null,1]}'
		);
		const record = { ...current, metadata };
		expect(browserStateSchema.parse(record)).toBe(record);
		expect(browserStateSchema.parse(record).activities).toBe(
			current.activities
		);
		expect(browserStateSchema.parse(record).settings).toBe(current.settings);
		expect(
			browserStateSchema.safeParse({
				...record,
				activities: [{ kind: "camera" }],
			}).success
		).toBe(false);
		expect(
			browserStateSchema.safeParse({ ...record, surface: "unknown" }).success
		).toBe(false);
	});
	it("defaults corrupt stored fields independently without enabling developer controls", () => {
		const defaults = defaultBrowserSettings("/Downloads");
		const permission = {
			origin: "https://example.com",
			permission: "camera",
			decision: "allow",
		} satisfies BrowserSettings["sitePermissions"][number];
		const result = browserStoredSettingsSchema(defaults).parse({
			allowControl: false,
			askWhereToSave: "true",
			developerCdp: 1,
			downloadDirectory: " /Chosen ",
			sitePermissions: [permission, { origin: "" }, null],
		});
		expect(result.allowControl).toBe(false);
		expect(result.developerCdp).toBe(false);
		expect(result.askWhereToSave).toBe(false);
		expect(result.downloadDirectory).toBe(" /Chosen ");
		expect(result.sitePermissions).toHaveLength(1);
		expect(result.sitePermissions[0]).toBe(permission);
		for (const value of [null, undefined, 1, "wrong", []]) {
			expect(browserStoredSettingsSchema(defaults).parse(value)).toEqual(
				defaults
			);
		}
	});
});

describe("native persisted Browser profiles", () => {
	it("retains legacy downloads without inventing absent native counters", () => {
		const legacy = {
			id: "download-1",
			filename: "old.zip",
			path: "/tmp/old.zip",
			url: "https://example.test/old.zip",
			state: "completed",
		} satisfies BrowserLegacyDownloadEntry;
		const parsed = browserPersistedProfileSchema.parse({ downloads: [legacy] });
		expect(parsed.downloads[0]).toBe(legacy);
		expect(Object.hasOwn(parsed.downloads[0] ?? {}, "totalBytes")).toBe(false);
		expect(browserDownloadRecordSchema.parse(legacy)).toBe(legacy);
		expect(formatBytes(parsed.downloads[0]?.totalBytes)).toBe("0 B");
	});
	it("recovers profile arrays independently, preserves valid raw rows and caps extensions", () => {
		const history = {
			id: "visit",
			title: "Old visit",
			url: "https://example.test",
			visitedAt: 42,
			nativeMetadata: { retained: true },
		};
		const downloads = {
			id: "download",
			filename: "old.zip",
			path: "/tmp/old.zip",
			url: "https://example.test",
			state: "progressing",
			percent: "42",
			totalBytes: { legacy: true },
		} satisfies BrowserLegacyDownloadEntry;
		const parsed = browserPersistedProfileSchema.parse({
			history: [null, history],
			downloads: [downloads, { id: 4 }],
			extensionPaths: [42, " /extension ", "/extension", "", "/second"],
		});
		expect(parsed.history).toEqual([history]);
		expect(parsed.history[0]).toBe(history);
		expect(parsed.downloads[0]).toBe(downloads);
		expect(parsed.extensionPaths).toEqual(["/extension", "/second"]);
		expect(
			browserPersistedProfileSchema.parse({ history: null, downloads: 42 })
				.history
		).toEqual([]);
		expect(browserPersistedProfileSchema.parse(null).downloads).toEqual([]);
	});
});
