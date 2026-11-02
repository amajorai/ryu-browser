import { afterEach, describe, expect, it } from "bun:test";
import catalogs from "../i18n/shell-catalog.generated.json";
import { setShellLocale } from "../i18n/shell-i18n.ts";
import {
	cookiesImportedMessage,
	formatPercent,
	menuLabels,
	optionLabel,
} from "./labels.ts";
import {
	adoptShellLocale,
	applyDocumentLocale,
	themeLocale,
} from "./locale.ts";

const CATALOGS: Record<string, Record<string, string>> = catalogs;

afterEach(() => {
	setShellLocale("en");
});

describe("shell renderer labels", () => {
	it("reads the menu and option labels from the catalog under ja", () => {
		setShellLocale("ja");
		const ja = CATALOGS.ja ?? {};
		const labels = menuLabels();
		expect(labels.history).toBe(ja.History ?? "History");
		expect(labels.downloads).toBe(ja.Downloads ?? "Downloads");
		expect(labels.findInPage).toBe(ja["Find in page"] ?? "Find in page");
		expect(labels.zoom).toBe(ja.Zoom ?? "Zoom");
		expect(optionLabel("never")).toBe(ja.Never ?? "Never");
		expect(labels.history).not.toBe("History");
	});

	it("keeps the English labels and title-cases unknown values", () => {
		expect(menuLabels().browserSettings).toBe("Browser settings");
		expect(optionLabel("always-allow")).toBe("Always Allow");
		expect(optionLabel("some-new-value")).toBe("Some New Value");
		expect(cookiesImportedMessage(1)).toBe("1 cookie imported");
		expect(cookiesImportedMessage(3)).toBe("3 cookies imported");
		expect(formatPercent(42)).toBe("42%");
	});
});

describe("shell document locale", () => {
	it("writes lang and dir=rtl under ar", () => {
		const root = { dir: "", lang: "" };
		expect(adoptShellLocale("ar-EG", root)).toBe(true);
		expect(root).toEqual({ dir: "rtl", lang: "ar" });
		setShellLocale("de");
		applyDocumentLocale(root);
		expect(root).toEqual({ dir: "ltr", lang: "de" });
	});

	it("follows the theme snapshot's --ryu-locale", () => {
		expect(themeLocale({ "--ryu-locale": "ja-JP" })).toBe("ja-JP");
		expect(themeLocale({ "--ryu-locale": "system" })).toBeNull();
		expect(themeLocale({})).toBeNull();
	});
});
