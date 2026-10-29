import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { BrowserActivity } from "../src/main/activity.ts";
import type {
	BrowserSettings,
	BrowserState,
	BrowserTabState,
} from "../src/main/browser-state.ts";
import {
	type BrowserShellEffect,
	FINDABLE_PAGE_TEXT,
	installBrowserShellFixture,
	makeBrowserState,
} from "./browser-shell.fixture.ts";

const EVIDENCE_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"evidence"
);

async function stateFor(page: Page): Promise<BrowserState> {
	const state = await page.evaluate(() =>
		window.__browserShellFixture?.getState()
	);
	if (!state) {
		throw new Error("Browser shell fixture is not installed");
	}
	return state;
}

async function effectsFor(page: Page): Promise<BrowserShellEffect[]> {
	return page.evaluate(() => window.__browserShellFixture?.calls ?? []);
}

async function openMenuItem(page: Page, label: string): Promise<void> {
	await page.getByRole("button", { name: "Browser menu" }).click();
	await page
		.locator(".browser-menu")
		.getByRole("button", { name: label, exact: true })
		.click();
}

async function openSettings(page: Page): Promise<void> {
	await openMenuItem(page, "Browser settings");
	await expect(
		page.getByRole("heading", { name: "Browser", level: 1 })
	).toBeVisible();
}

async function captureEvidence(page: Page, name: string): Promise<void> {
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: path.resolve(EVIDENCE_DIR, name),
		fullPage: true,
	});
}

async function selectSetting(
	page: Page,
	label: string,
	key: keyof BrowserSettings,
	value: string
): Promise<void> {
	const row = page.locator(".settings-row").filter({ hasText: label });
	await row.locator("select").selectOption(value);
	await expect
		.poll(async () => (await stateFor(page)).settings[key])
		.toBe(value);
}

test("tabs and address navigation retry, read back, and preserve the selected tab", async ({
	page,
}) => {
	const initialTabs: BrowserTabState[] = [
		{
			canGoBack: false,
			canGoForward: false,
			id: "tab-start",
			loading: false,
			title: "Start page",
			url: "https://start.example.test/",
			zoomPercent: 100,
		},
		{
			canGoBack: false,
			canGoForward: false,
			id: "tab-secondary",
			loading: false,
			title: "Secondary tab",
			url: "https://secondary.example.test/",
			zoomPercent: 100,
		},
	];
	await installBrowserShellFixture(
		page,
		makeBrowserState({ tabs: initialTabs, activeId: "tab-start" }),
		{ navigate: ["Navigation interrupted by the local fixture"] }
	);
	await page.goto("/index.html");

	const address = page.getByRole("textbox", { name: "Address" });
	const targetUrl = "https://docs.example.test/guide?from=browser";
	await expect(address).toHaveValue("https://start.example.test/");
	await address.fill(targetUrl);
	await address.press("Enter");
	await expect(
		page.getByText("Navigation interrupted by the local fixture", {
			exact: true,
		})
	).toBeVisible();
	await expect(address).toHaveValue(targetUrl);
	await expect
		.poll(async () => (await stateFor(page)).activeUrl)
		.toBe("https://start.example.test/");

	await address.press("Enter");
	await expect(page.locator(".tab.active .tab-title")).toHaveText(
		"docs.example.test"
	);
	await expect(page.getByRole("textbox", { name: "Address" })).toHaveValue(
		targetUrl
	);
	await page.getByRole("button", { name: "Back" }).click();
	await expect(page.getByRole("textbox", { name: "Address" })).toHaveValue(
		"https://start.example.test/"
	);
	await page.getByRole("button", { name: "Forward" }).click();
	await expect(page.getByRole("textbox", { name: "Address" })).toHaveValue(
		targetUrl
	);
	await page.getByRole("button", { name: "Reload" }).click();

	await page.getByRole("button", { name: "New tab" }).click();
	await expect(page.locator(".tab.active .tab-title")).toHaveText("New tab");
	const newTab = page.getByRole("tab", { name: /New tab/ });
	await newTab.getByRole("button", { name: "Close tab" }).click();
	await expect(page.locator(".tab.active .tab-title")).toHaveText(
		"docs.example.test"
	);
	await page.getByRole("tab", { name: /Secondary tab/ }).click();
	await expect(page.getByRole("textbox", { name: "Address" })).toHaveValue(
		"https://secondary.example.test/"
	);

	expect(await effectsFor(page)).toEqual([
		{ method: "navigate", args: [targetUrl] },
		{ method: "navigate", args: [targetUrl] },
		{ method: "back", args: [] },
		{ method: "forward", args: [] },
		{ method: "reload", args: [] },
		{ method: "open", args: [null] },
		{ method: "close", args: ["tab-fixture-2"] },
		{ method: "select", args: ["tab-secondary"] },
	]);
	const state = await stateFor(page);
	expect(state.activeId).toBe("tab-secondary");
	expect(state.activeUrl).toBe("https://secondary.example.test/");
	await captureEvidence(page, "browser-shell-navigation-readback.png");
});

test("find-in-page retries against local page text, advances matches, and stops on close", async ({
	page,
}) => {
	await installBrowserShellFixture(page, makeBrowserState(), {
		find: ["Find is temporarily unavailable"],
	});
	await page.goto("/index.html");
	expect(
		await page.evaluate(() => window.__browserShellFixture?.getFindableText())
	).toBe(FINDABLE_PAGE_TEXT);
	await openMenuItem(page, "Find in page");

	const find = page.getByRole("textbox", { name: "Find in page" });
	await find.fill("permission settings");
	await find.press("Enter");
	await expect(page.getByText("Find is temporarily unavailable")).toBeVisible();
	await expect(find).toHaveValue("permission settings");
	await find.press("Enter");
	await expect
		.poll(() =>
			page.evaluate(() => window.__browserShellFixture?.getFindResult())
		)
		.toEqual({ activeMatchOrdinal: 0, matches: 0 });
	await find.fill("browser");
	await find.press("Enter");
	await expect(page.locator(".find-count")).toHaveText("1/3");
	await expect
		.poll(() =>
			page.evaluate(() => window.__browserShellFixture?.getFindResult())
		)
		.toEqual({ activeMatchOrdinal: 1, matches: 3 });
	await find.press("Enter");
	await expect(page.locator(".find-count")).toHaveText("2/3");
	await expect(page.getByText("Find is temporarily unavailable")).toBeHidden();
	await captureEvidence(page, "browser-shell-find-results.png");
	await find.fill("not present in the local page");
	await find.press("Enter");
	await expect(page.locator(".find-count")).toHaveText("");
	await expect
		.poll(() =>
			page.evaluate(() => window.__browserShellFixture?.getFindResult())
		)
		.toEqual({ activeMatchOrdinal: 0, matches: 0 });

	await page.getByRole("button", { name: "Close find" }).click();
	await expect(page.getByRole("textbox", { name: "Find in page" })).toHaveCount(
		0
	);
	await expect
		.poll(() =>
			page.evaluate(() => window.__browserShellFixture?.getOverlayVisible())
		)
		.toBe(false);
	expect(await effectsFor(page)).toEqual([
		{ method: "find", args: ["permission settings"] },
		{ method: "find", args: ["permission settings"] },
		{ method: "find", args: ["browser"] },
		{ method: "find", args: ["browser"] },
		{ method: "find", args: ["not present in the local page"] },
		{ method: "stopFind", args: [] },
	]);
});

test("Browser settings persist exact preferences, site overrides, and elevated CDP restart state", async ({
	page,
}) => {
	await installBrowserShellFixture(page, makeBrowserState(), {
		addSitePermission: ["Site permission write failed"],
		setSetting: ["Browser access write failed"],
	});
	await page.goto("/index.html");
	await openSettings(page);

	const browserControl = page.locator(".control-card [role='switch']");
	await expect(browserControl).toHaveAttribute("aria-checked", "true");
	await browserControl.click();
	await expect(page.getByText("Browser access write failed")).toBeVisible();
	await expect(browserControl).toHaveAttribute("aria-checked", "true");
	await browserControl.click();
	await expect(browserControl).toHaveAttribute("aria-checked", "false");

	await selectSetting(
		page,
		"Web URL and link open destination",
		"webLinkDestination",
		"ryu"
	);
	await selectSetting(
		page,
		"Local URL open destination",
		"localLinkDestination",
		"default"
	);
	await selectSetting(
		page,
		"Annotation screenshots",
		"annotationScreenshots",
		"never"
	);
	await selectSetting(page, "Approval", "approval", "always-ask");
	await selectSetting(
		page,
		"Choose whether Ryu can access your built-in browser history",
		"historyAccess",
		"always-allow"
	);
	const saveLocation = page
		.locator(".settings-row")
		.filter({ hasText: "Location" });
	await saveLocation.getByRole("button", { name: "Change" }).click();
	await expect(saveLocation).toContainText("/fixture/Exports");
	const askWhereToSave = page
		.locator(".settings-row")
		.filter({ hasText: "Ask where to save downloads" })
		.getByRole("switch");
	await askWhereToSave.click();
	await expect(askWhereToSave).toHaveAttribute("aria-checked", "true");

	const permissions = page.locator(".site-permissions");
	await permissions.getByRole("button", { name: /Add/ }).click();
	const form = permissions.locator(".permission-form");
	const origin = form.locator("input");
	await origin.fill("file:///private/notes.txt");
	await form.getByRole("button", { name: "Save" }).click();
	await expect(
		page.getByText("Use an http or https site origin", { exact: true })
	).toBeVisible();
	expect(
		await effectsFor(page).then((calls) =>
			calls.filter((call) => call.method === "addSitePermission")
		)
	).toHaveLength(0);

	await origin.fill("https://camera.example.test/path");
	await form.locator("select").nth(0).selectOption("microphone");
	await form.locator("select").nth(1).selectOption("deny");
	await form.evaluate((node) => {
		node.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true })
		);
		node.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true })
		);
	});
	await expect(
		page.getByText("Site permission write failed", { exact: true })
	).toBeVisible();
	expect(
		await effectsFor(page).then((calls) =>
			calls.filter((call) => call.method === "addSitePermission")
		)
	).toHaveLength(1);
	await expect(origin).toHaveValue("https://camera.example.test/path");
	await expect(form.locator("select").nth(0)).toHaveValue("microphone");
	await expect(form.locator("select").nth(1)).toHaveValue("deny");
	await expect(permissions).toContainText("No site-specific permissions yet");
	await form.getByRole("button", { name: "Save" }).click();
	await expect(permissions).toContainText("https://camera.example.test");
	await expect(permissions).toContainText("microphone · deny");
	await permissions.getByRole("button", { name: "Remove" }).click();
	await expect(
		permissions.getByText("No site-specific permissions yet")
	).toBeVisible();

	const cdpToggle = page.locator(".developer-card [role='switch']");
	await cdpToggle.click();
	await expect(
		page.getByText(
			"Restart Ryu Browser for the CDP port change to take effect."
		)
	).toBeVisible();
	const state = await stateFor(page);
	expect(state.settings).toMatchObject({
		allowControl: false,
		annotationScreenshots: "never",
		approval: "always-ask",
		askWhereToSave: true,
		developerCdp: true,
		downloadDirectory: "/fixture/Exports",
		historyAccess: "always-allow",
		localLinkDestination: "default",
		webLinkDestination: "ryu",
	});
	const calls = await effectsFor(page);
	expect(calls.filter((call) => call.method === "setSetting")).toEqual([
		{ method: "setSetting", args: ["allowControl", false] },
		{ method: "setSetting", args: ["allowControl", false] },
		{ method: "setSetting", args: ["webLinkDestination", "ryu"] },
		{ method: "setSetting", args: ["localLinkDestination", "default"] },
		{ method: "setSetting", args: ["annotationScreenshots", "never"] },
		{ method: "setSetting", args: ["approval", "always-ask"] },
		{ method: "setSetting", args: ["historyAccess", "always-allow"] },
		{ method: "setSetting", args: ["askWhereToSave", true] },
	]);
	expect(calls.filter((call) => call.method === "addSitePermission")).toEqual([
		{
			method: "addSitePermission",
			args: [
				{
					decision: "deny",
					origin: "https://camera.example.test",
					permission: "microphone",
				},
			],
		},
		{
			method: "addSitePermission",
			args: [
				{
					decision: "deny",
					origin: "https://camera.example.test",
					permission: "microphone",
				},
			],
		},
	]);
	expect(
		calls.filter((call) => call.method === "removeSitePermission")
	).toEqual([
		{
			method: "removeSitePermission",
			args: ["https://camera.example.test", "microphone"],
		},
	]);
	expect(calls.filter((call) => call.method === "setCdpEnabled")).toEqual([
		{ method: "setCdpEnabled", args: [true] },
	]);
	await captureEvidence(page, "browser-shell-settings-readback.png");
});

test("history and downloads open the exact saved items and clear with readback", async ({
	page,
}) => {
	const initialState = makeBrowserState();
	await installBrowserShellFixture(page, initialState);
	await page.goto("/index.html");
	await openMenuItem(page, "History");
	const historyRow = page
		.locator(".history-row")
		.filter({ hasText: "Earlier browser guide" });
	await historyRow.getByRole("button", { name: "Open" }).click();
	await expect(page.getByRole("textbox", { name: "Address" })).toHaveValue(
		"https://docs.example.test/previous"
	);
	await expect
		.poll(async () => (await stateFor(page)).activeUrl)
		.toBe("https://docs.example.test/previous");
	await expect.poll(async () => (await stateFor(page)).surface).toBe("browser");
	await expect(page.getByRole("textbox", { name: "Address" })).toBeVisible();

	await page.getByRole("button", { name: "Browser menu" }).click();
	await page
		.locator(".browser-menu")
		.getByRole("button", { name: "History", exact: true })
		.click();
	await page.getByRole("button", { name: "Clear history" }).click();
	await expect(
		page.getByText("No pages in your browsing history yet.")
	).toBeVisible();
	await page.getByRole("button", { name: "Back to browser" }).click();

	await page
		.locator(".browser-toolbar")
		.getByRole("button", { name: "Downloads", exact: true })
		.click();
	await expect(page.locator(".downloads-popover")).toContainText(
		"release-notes.pdf"
	);
	await page.getByRole("button", { name: "Browser menu" }).click();
	await expect(page.locator(".downloads-popover")).toHaveCount(0);
	await page
		.locator(".browser-menu")
		.getByRole("button", { name: "Downloads", exact: true })
		.click();
	await expect(page.getByRole("heading", { name: "Downloads" })).toBeVisible();
	await expect(
		page.getByText("release-notes.pdf", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Open folder" }).click();
	await page.getByRole("button", { name: "Clear history" }).click();
	await expect(page.getByText("No downloads yet.")).toBeVisible();
	await expect.poll(async () => (await stateFor(page)).downloads).toEqual([]);
	await captureEvidence(page, "browser-shell-downloads-cleared.png");

	await page.getByRole("button", { name: "Back to browser" }).click();
	await page.getByRole("button", { name: "Browser menu" }).click();
	await page.getByRole("button", { name: "Clear browsing data" }).click();
	await expect(
		page.getByText("Browsing data cleared", { exact: true })
	).toBeVisible();
	const state = await stateFor(page);
	expect(state.history).toEqual([]);
	expect(state.downloads).toEqual([]);
	expect(await effectsFor(page)).toEqual([
		{ method: "setSurface", args: ["history"] },
		{ method: "open", args: ["https://docs.example.test/previous"] },
		{ method: "setSurface", args: ["browser"] },
		{ method: "setSurface", args: ["history"] },
		{ method: "clearHistory", args: [] },
		{ method: "setSurface", args: ["browser"] },
		{ method: "setSurface", args: ["downloads"] },
		{ method: "openDownloadsFolder", args: [] },
		{ method: "clearDownloads", args: [] },
		{ method: "setSurface", args: ["browser"] },
		{ method: "clearBrowsingData", args: [] },
	]);
});

test("activity, zoom, device toolbar, screenshots, and cookie import expose exact local effects", async ({
	page,
}) => {
	const activeActivity: BrowserActivity = {
		detail: "Microphone access",
		id: "tab:tab-meeting:microphone",
		kind: "microphone",
		selectable: true,
		source: "browser-tab",
		startedAt: Date.now() - 2000,
		status: "active",
		tabId: "tab-meeting",
		tabTitle: "Team meeting",
		tabUrl: "https://meeting.example.test/",
		updatedAt: Date.now(),
	};
	const meetingTab: BrowserTabState = {
		canGoBack: false,
		canGoForward: false,
		id: "tab-meeting",
		loading: false,
		title: "Team meeting",
		url: "https://meeting.example.test/",
		zoomPercent: 100,
	};
	await installBrowserShellFixture(
		page,
		makeBrowserState({
			activities: [activeActivity],
			tabs: [
				{
					canGoBack: false,
					canGoForward: false,
					id: "tab-start",
					loading: false,
					title: "Start page",
					url: "https://start.example.test/",
					zoomPercent: 100,
				},
				meetingTab,
			],
		})
	);
	await page.goto("/index.html");
	await page.getByRole("button", { name: "Activity center" }).click();
	await expect(page.locator(".activity-heading")).toHaveText("Activity");
	await expect(page.locator(".activity-summary")).toHaveText("1 active item");
	await expect(
		page.getByRole("button", { name: "Close activity center" })
	).toBeVisible();
	await captureEvidence(page, "browser-shell-activity-center.png");
	const microphoneRow = page.getByRole("button", {
		name: /Microphone.*Team meeting/,
	});
	await microphoneRow.focus();
	await page.keyboard.press("Enter");
	await expect(page.locator(".tab.active .tab-title")).toHaveText(
		"Team meeting"
	);
	await expect
		.poll(async () => (await stateFor(page)).activeId)
		.toBe("tab-meeting");
	await page.getByRole("button", { name: "Activity center" }).click();
	await page.getByRole("button", { name: "Close activity center" }).click();
	await expect(page.locator(".activity-popover")).toHaveCount(0);

	await page.getByRole("button", { name: "Browser menu" }).click();
	await page.getByRole("button", { name: "Zoom in" }).click();
	await expect(page.locator(".zoom-value")).toHaveText("110%");
	await page.getByRole("button", { name: "Show device toolbar" }).click();
	await expect
		.poll(async () => (await stateFor(page)).deviceToolbar)
		.toBe(true);

	await page.getByRole("button", { name: "Browser menu" }).click();
	await page.getByRole("button", { name: "Take a screenshot" }).click();
	await expect(
		page.getByText("Screenshot saved to /fixture/Downloads/browser-page.png", {
			exact: true,
		})
	).toBeVisible();
	await expect(page.locator(".browser-menu")).toHaveCount(0);
	await page.getByRole("button", { name: "Browser menu" }).click();
	await page
		.getByRole("button", { name: "Import cookies…", exact: true })
		.click();
	await expect(
		page.getByText("3 cookies imported", { exact: true })
	).toBeVisible();
	await expect(page.locator(".browser-menu")).toHaveCount(0);
	expect(await effectsFor(page)).toEqual([
		{ method: "select", args: ["tab-meeting"] },
		{ method: "zoom", args: ["in"] },
		{ method: "toggleDeviceToolbar", args: [] },
		{ method: "showScreenshot", args: [] },
		{ method: "importCookies", args: [] },
	]);
});

test("extension settings retry local load, remove by id, and preserve the OS password boundary", async ({
	page,
}) => {
	await installBrowserShellFixture(page, makeBrowserState(), {
		chooseExtensionDirectory: [
			"The selected folder is not a browser extension",
		],
	});
	await page.goto("/index.html");
	await openSettings(page);

	const extensions = page.locator(".browser-extensions");
	await extensions.getByRole("button", { name: "Load unpacked" }).click();
	await expect(
		page.getByText("The selected folder is not a browser extension", {
			exact: true,
		})
	).toBeVisible();
	await expect(extensions).toContainText("No extensions installed");
	await extensions.getByRole("button", { name: "Load unpacked" }).click();
	await expect(extensions).toContainText("Fixture extension");
	await expect(extensions).toContainText("Version 1.2.3");
	await extensions.getByRole("button", { name: "Remove" }).click();
	await expect(extensions).toContainText("No extensions installed");

	const passwordRow = page
		.locator(".settings-row")
		.filter({ hasText: "Password manager" });
	await passwordRow.getByRole("button", { name: "Manage" }).click();
	await expect(
		page.getByRole("heading", { name: "Passwords and autofill" })
	).toBeVisible();
	await expect(
		page.getByText(/Ryu never exposes saved passwords/)
	).toBeVisible();
	await expect(page.getByText(/secret|password value/i)).toHaveCount(0);
	await page.getByRole("button", { name: "Add password" }).click();
	await expect(
		page.getByText(
			"Password manager connection is required before adding credentials",
			{ exact: true }
		)
	).toBeVisible();
	const calls = await effectsFor(page);
	expect(
		calls.filter((call) => call.method === "chooseExtensionDirectory")
	).toHaveLength(2);
	expect(calls.filter((call) => call.method === "removeExtension")).toEqual([
		{ method: "removeExtension", args: ["fixture-extension"] },
	]);
	expect(calls.some((call) => /password/i.test(call.method))).toBe(false);
	await captureEvidence(
		page,
		"browser-shell-extension-and-password-boundary.png"
	);
});

test("live host theme updates browser chrome without changing the active page", async ({
	page,
}) => {
	await installBrowserShellFixture(page, makeBrowserState());
	await page.goto("/index.html");
	const activeUrl = (await stateFor(page)).activeUrl;
	await expect
		.poll(() =>
			page.evaluate(() =>
				document.documentElement.style.getPropertyValue("--primary")
			)
		)
		.toBe("#0099ff");

	await page.evaluate(() =>
		window.__browserShellFixture?.emitTheme({
			"--background": "#20252b",
			"--foreground": "#f7f8fa",
			"--primary": "#d946ef",
		})
	);
	await expect
		.poll(() =>
			page.evaluate(() =>
				document.documentElement.style.getPropertyValue("--primary")
			)
		)
		.toBe("#d946ef");
	expect((await stateFor(page)).activeUrl).toBe(activeUrl);
	expect(await effectsFor(page)).toEqual([]);
	await captureEvidence(page, "browser-shell-live-theme.png");
});
