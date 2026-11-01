import { describe, expect, it } from "bun:test";
import { browserThemeSchema } from "../main/browser-records.ts";
import {
	browserCookieImportResultSchema,
	browserScreenshotResultSchema,
} from "./ipc-records.ts";

describe("native browser IPC replies", () => {
	it("preserves actual saved and cancelled screenshot replies", () => {
		for (const reply of [
			{ saved: false },
			{
				saved: true,
				path: "/tmp/screenshot.png",
				nativeMetadata: { source: "host" },
			},
		]) {
			expect(browserScreenshotResultSchema.parse(reply)).toBe(reply);
		}
		expect(
			browserScreenshotResultSchema.safeParse({ saved: "true" }).success
		).toBe(false);
	});
	it("preserves cookie import counts, optional messages and theme maps", () => {
		const imported = { imported: 42, message: "Imported cookies" };
		expect(browserCookieImportResultSchema.parse(imported)).toBe(imported);
		expect(
			browserCookieImportResultSchema.safeParse({ imported: "42" }).success
		).toBe(false);
		const tokens = JSON.parse(
			'{"--background":"#000","__proto__":"native-field"}'
		);
		expect(browserThemeSchema.parse(tokens)).toBe(tokens);
		expect(Object.hasOwn(tokens, "__proto__")).toBe(true);
	});
});
