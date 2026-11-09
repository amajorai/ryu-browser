import { describe, expect, it } from "bun:test";
import {
	browserCookieExportSchema,
	browserImportedCookieSchema,
} from "./cookie-records.ts";

describe("native browser cookie exports", () => {
	it("accepts root lists and exporter envelopes without changing selected entries", () => {
		const cookie = {
			name: "session",
			value: "native",
			domain: ".example.test",
			path: "/",
			secure: true,
			httpOnly: true,
			sameSite: "strict" as const,
			expirationDate: 42,
		};
		const exported = browserCookieExportSchema.parse([cookie]);
		expect(Array.isArray(exported)).toBe(true);
		if (!Array.isArray(exported)) {
			throw new Error("Expected a native cookie list");
		}
		expect(exported[0]).toBe(cookie);
		expect(browserImportedCookieSchema.parse(cookie)).toEqual({
			...cookie,
			url: undefined,
		});
		expect(
			browserCookieExportSchema.safeParse({ cookies: [cookie] }).success
		).toBe(true);
	});
	it("keeps exporter defaults and exact strict-boolean semantics", () => {
		const parsed = browserImportedCookieSchema.parse({
			name: "session",
			path: "relative",
			secure: "true",
			httpOnly: 1,
			sameSite: "unsupported",
		});
		expect(parsed.path).toBe("/");
		expect(parsed.value).toBe("");
		expect(parsed.domain).toBe("");
		expect(parsed.secure).toBe(false);
		expect(parsed.httpOnly).toBe(false);
		expect(parsed.sameSite).toBe("unspecified");
	});
});
