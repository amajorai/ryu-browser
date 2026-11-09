import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyChromiumLang, chromiumLangTag } from "./chromium-lang.ts";
import { writeStoredShellLocale } from "./locale-store.ts";

const directories: string[] = [];

function profileWith(locale: string | null): string {
	const dir = mkdtempSync(join(tmpdir(), "ryu-browser-lang-"));
	directories.push(dir);
	if (locale) {
		writeStoredShellLocale(dir, locale);
	}
	return dir;
}

function recorder() {
	const switches: [string, string | undefined][] = [];
	return {
		commandLine: {
			appendSwitch(name: string, value?: string) {
				switches.push([name, value]);
			},
		},
		switches,
	};
}

afterEach(() => {
	for (const dir of directories.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe("applyChromiumLang", () => {
	it("appends the stored Ryu language on Windows and Linux", () => {
		for (const platform of ["win32", "linux"]) {
			const { commandLine, switches } = recorder();
			expect(
				applyChromiumLang({
					commandLine,
					envLocale: undefined,
					platform,
					userDataDir: profileWith("ja"),
				})
			).toBe("ja");
			expect(switches).toEqual([["lang", "ja"]]);
		}
	});

	it("appends nothing on macOS", () => {
		const { commandLine, switches } = recorder();
		expect(
			applyChromiumLang({
				commandLine,
				envLocale: "de",
				platform: "darwin",
				userDataDir: profileWith("ja"),
			})
		).toBeNull();
		expect(switches).toEqual([]);
	});

	it("prefers a pinned RYU_LOCALE and leaves Chromium on the OS language otherwise", () => {
		const pinned = recorder();
		applyChromiumLang({
			commandLine: pinned.commandLine,
			envLocale: "pt_BR.UTF-8",
			platform: "linux",
			userDataDir: profileWith("ja"),
		});
		expect(pinned.switches).toEqual([["lang", "pt-BR"]]);
		const unset = recorder();
		applyChromiumLang({
			commandLine: unset.commandLine,
			envLocale: undefined,
			platform: "win32",
			userDataDir: profileWith(null),
		});
		expect(unset.switches).toEqual([]);
	});
});

describe("chromiumLangTag", () => {
	it("maps Ryu tags to locales Chromium ships", () => {
		expect(chromiumLangTag(["zh"])).toBe("zh-CN");
		expect(chromiumLangTag(["en"])).toBe("en-US");
		expect(chromiumLangTag(["en_GB"])).toBe("en-GB");
		expect(chromiumLangTag(["system", "", "ar-EG"])).toBe("ar");
		expect(chromiumLangTag(["xx-invalid-?", null])).toBeNull();
	});
});
