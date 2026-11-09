import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveShellLocale } from "../i18n/shell-i18n.ts";
import {
	persistShellLocale,
	readStoredShellLocale,
	setLocaleStoreDirectory,
	startupLocaleCandidates,
	writeStoredShellLocale,
} from "./locale-store.ts";

const directories: string[] = [];

function freshDirectory(): string {
	const dir = mkdtempSync(join(tmpdir(), "ryu-browser-locale-"));
	directories.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of directories.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe("shell locale store", () => {
	it("round-trips the persisted locale", () => {
		const dir = freshDirectory();
		expect(readStoredShellLocale(dir)).toBeNull();
		expect(writeStoredShellLocale(dir, "ja")).toBe(true);
		expect(readStoredShellLocale(dir)).toBe("ja");
	});

	it("rejects malformed tags and unreadable files", () => {
		const dir = freshDirectory();
		expect(writeStoredShellLocale(dir, "../../etc")).toBe(false);
		expect(writeStoredShellLocale(dir, 42)).toBe(false);
		writeFileSync(join(dir, "shell-locale.json"), "{not json");
		expect(readStoredShellLocale(dir)).toBeNull();
	});

	it("persists theme pushes into the configured directory", () => {
		const dir = freshDirectory();
		setLocaleStoreDirectory(dir);
		persistShellLocale("ar");
		persistShellLocale(undefined);
		expect(
			JSON.parse(readFileSync(join(dir, "shell-locale.json"), "utf8"))
		).toEqual({ locale: "ar" });
	});

	it("prefers the stored Ryu language over the OS languages at startup", () => {
		const dir = freshDirectory();
		writeStoredShellLocale(dir, "ja");
		const candidates = startupLocaleCandidates({
			envLocale: undefined,
			storedLocale: readStoredShellLocale(dir),
			systemLocales: ["de-DE", "en-US"],
		});
		expect(resolveShellLocale(candidates)).toBe("ja");
		expect(
			resolveShellLocale(
				startupLocaleCandidates({
					envLocale: "ko",
					storedLocale: "ja",
					systemLocales: ["de-DE"],
				})
			)
		).toBe("ko");
		expect(
			resolveShellLocale(
				startupLocaleCandidates({
					envLocale: undefined,
					storedLocale: null,
					systemLocales: ["de-DE"],
				})
			)
		).toBe("de");
	});
});
