import { describe, expect, it } from "bun:test";
import {
	type BrowserSettings,
	cookieImportUrl,
	defaultBrowserSettings,
	formatBytes,
	formatRelativeTime,
	normalizeBrowserSettings,
	safeDownloadFilename,
} from "./browser-state.ts";

describe("browser settings", () => {
	it("provides safe defaults for a new profile", () => {
		const settings = defaultBrowserSettings("/tmp/Downloads");

		expect(settings.downloadDirectory).toBe("/tmp/Downloads");
		expect(settings.allowControl).toBe(true);
		expect(settings.developerCdp).toBe(false);
		expect(settings.sitePermissions).toEqual([]);
	});

	it("keeps only valid persisted site permissions", () => {
		const settings = normalizeBrowserSettings(
			{
				sitePermissions: [
					{
						decision: "allow",
						origin: "https://example.test",
						permission: "microphone",
					},
					{ decision: "allow", origin: "not-a-permission", permission: "nope" },
				],
			} as unknown as Partial<BrowserSettings>,
			"/tmp/Downloads"
		);

		expect(settings.sitePermissions).toEqual([
			{
				decision: "allow",
				origin: "https://example.test",
				permission: "microphone",
			},
		]);
	});
});

describe("browser cookie import helpers", () => {
	it("removes the leading dot from exported cookie domains", () => {
		expect(cookieImportUrl(undefined, ".example.com", "/")).toBe(
			"https://example.com/"
		);
	});

	it("preserves an explicit cookie URL", () => {
		expect(
			cookieImportUrl("https://sub.example.com/path", ".example.com", "/")
		).toBe("https://sub.example.com/path");
	});
});

describe("browser download helpers", () => {
	it("keeps suggested download names inside the download directory", () => {
		expect(safeDownloadFilename("../../secret.txt")).toBe("secret.txt");
		expect(safeDownloadFilename("C:\\Users\\me\\report.pdf")).toBe(
			"report.pdf"
		);
		expect(safeDownloadFilename(".")).toBe("download");
		expect(safeDownloadFilename(undefined)).toBe("download");
	});
});

describe("browser display helpers", () => {
	it("formats download sizes without exposing negative or non-finite values", () => {
		expect(formatBytes(-1)).toBe("0 B");
		expect(formatBytes(Number.NaN)).toBe("0 B");
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1_048_576)).toBe("1.0 MB");
	});

	it("formats relative history times", () => {
		const now = 1_000_000;
		expect(formatRelativeTime(now - 10_000, now)).toBe("Just now");
		expect(formatRelativeTime(now - 120_000, now)).toBe("2 min ago");
		expect(formatRelativeTime(now - 7_200_000, now)).toBe("2 hr ago");
	});
});
