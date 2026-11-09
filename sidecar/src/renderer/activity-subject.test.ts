import { afterEach, describe, expect, it } from "bun:test";
import catalogs from "../i18n/shell-catalog.generated.json";
import { setShellLocale } from "../i18n/shell-i18n.ts";
import type { BrowserActivity } from "../main/activity.ts";
import { activitySubject } from "./activity-subject.ts";

const CATALOGS: Record<string, Record<string, string>> = catalogs;
const BASE = {
	detail: "",
	startedAt: 1,
	status: "active",
	updatedAt: 1,
} as const;

function computerUse(owner: string): BrowserActivity {
	return {
		...BASE,
		agentLabel: owner === "visible" ? "Ryu" : "Ryu agent",
		id: `computer-use:${owner}`,
		kind: "computer-use",
		selectable: false,
		source: "computer-use",
	};
}

function tab(tabTitle: string): BrowserActivity {
	return {
		...BASE,
		id: "tab:1:audio",
		kind: "audio",
		selectable: true,
		source: "browser-tab",
		tabId: "1",
		tabTitle,
		tabUrl: "https://example.com",
	};
}

afterEach(() => {
	setShellLocale("en");
});

describe("activity popover subject", () => {
	it("translates the bot agent label and the untitled tab under de", () => {
		setShellLocale("de");
		const de = CATALOGS.de ?? {};
		expect(activitySubject(computerUse("bot-123"))).toBe(de["Ryu agent"] ?? "");
		expect(activitySubject(computerUse("bot-123"))).not.toBe("Ryu agent");
		expect(activitySubject(tab(""))).toBe(de["New tab"] ?? "");
		expect(activitySubject(tab(""))).not.toBe("New tab");
	});

	it("keeps the brand for the visible window and a page's own title", () => {
		setShellLocale("de");
		expect(activitySubject(computerUse("visible"))).toBe("Ryu");
		expect(activitySubject(tab("Music"))).toBe("Music");
	});

	it("translates the bot agent label and the untitled tab under ja and ar", () => {
		for (const locale of ["ja", "ar"]) {
			setShellLocale(locale);
			const catalog = CATALOGS[locale] ?? {};
			expect(activitySubject(computerUse("bot-7"))).toBe(
				catalog["Ryu agent"] ?? ""
			);
			expect(activitySubject(computerUse("bot-7"))).not.toBe("Ryu agent");
			expect(activitySubject(tab(""))).toBe(catalog["New tab"] ?? "");
			expect(activitySubject(tab(""))).not.toBe("New tab");
		}
	});
});
