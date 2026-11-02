import { afterEach, describe, expect, it } from "bun:test";
import { shellLocaleFromArgv } from "./locale-argument.ts";
import { formatMessage } from "./message-format.ts";
import catalogs from "./shell-catalog.generated.json";
import { formatAge, formatByteCount } from "./shell-format.ts";
import {
	catalogLocaleFor,
	resolveShellLocale,
	setShellLocale,
	shellDirection,
	shellLocale,
	tl,
} from "./shell-i18n.ts";

const CATALOGS: Record<string, Record<string, string>> = catalogs;

afterEach(() => {
	setShellLocale("en");
});

describe("shell locale", () => {
	it("matches tags to catalog locales by language and script", () => {
		expect(catalogLocaleFor("ja-JP")).toBe("ja");
		expect(catalogLocaleFor("pt-PT")).toBe("pt-BR");
		expect(catalogLocaleFor("de_DE.UTF-8")).toBe("de");
		expect(catalogLocaleFor("en-GB")).toBe("en");
		expect(catalogLocaleFor("zh-TW")).toBeNull();
		expect(catalogLocaleFor("C")).toBeNull();
		expect(resolveShellLocale([undefined, "sv-SE", "fr-CA"])).toBe("fr");
		expect(resolveShellLocale(["xx"])).toBe("en");
	});

	it("keeps the current locale for a tag no catalog covers", () => {
		expect(setShellLocale("ko")).toBe(true);
		expect(setShellLocale("system")).toBe(false);
		expect(setShellLocale("zh-TW")).toBe(false);
		expect(shellLocale()).toBe("ko");
	});

	it("reads right-to-left for Arabic", () => {
		expect(shellDirection("ar")).toBe("rtl");
		expect(shellDirection("ja")).toBe("ltr");
	});

	it("translates from the shipped catalog and falls back to English", () => {
		setShellLocale("ja");
		expect(tl("Address")).toBe(CATALOGS.ja?.Address ?? "Address");
		expect(tl("A sentence no catalog has")).toBe("A sentence no catalog has");
	});

	it("reads the starting locale argument the main process passes", () => {
		expect(shellLocaleFromArgv(["electron", "--ryu-shell-locale=pt-BR"])).toBe(
			"pt-BR"
		);
		expect(shellLocaleFromArgv(["--ryu-shell-locale=<script>"])).toBeNull();
		expect(shellLocaleFromArgv([])).toBeNull();
	});
});

describe("message format", () => {
	it("fills arguments and locale plural categories", () => {
		const source =
			"{count, plural, one {# cookie imported} other {# cookies imported}}";
		expect(formatMessage(source, { count: 1 })).toBe("1 cookie imported");
		expect(formatMessage(source, { count: 1200 })).toBe(
			"1,200 cookies imported"
		);
		expect(
			formatMessage(
				"{count, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}",
				{ count: 3 },
				"ru"
			)
		).toBe("3 файла");
		expect(formatMessage("Version {version}", { version: "1.2" })).toBe(
			"Version 1.2"
		);
		expect(formatMessage("Hello {missing}")).toBe("Hello {missing}");
	});
});

describe("shell formatters", () => {
	const now = Date.UTC(2026, 9, 31, 12);

	it("keeps the English wording exactly", () => {
		expect(formatByteCount(0, "en")).toBe("0 B");
		expect(formatByteCount(1536, "en")).toBe("1.5 KB");
		expect(formatAge(now - 10_000, now, { locale: "en" })).toBe("Just now");
		expect(formatAge(now - 300_000, now, { locale: "en" })).toBe("5 min ago");
		expect(formatAge(now - 7_200_000, now, { locale: "en" })).toBe("2 hr ago");
	});

	it("uses Intl units and relative times elsewhere", () => {
		expect(formatByteCount(1536, "de")).toBe(
			new Intl.NumberFormat("de", {
				maximumFractionDigits: 1,
				minimumFractionDigits: 1,
				style: "unit",
				unit: "kilobyte",
				unitDisplay: "short",
			}).format(1.5)
		);
		expect(formatAge(now - 300_000, now, { locale: "ja" })).toBe(
			new Intl.RelativeTimeFormat("ja", {
				numeric: "auto",
				style: "short",
			}).format(-5, "minute")
		);
		setShellLocale("fr");
		expect(formatAge(now - 10_000, now)).toBe(
			new Intl.RelativeTimeFormat("fr", { numeric: "auto" }).format(0, "second")
		);
	});
});
