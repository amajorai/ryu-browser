/** The browser surface: tab strip, toolbar, find bar, and overflow menu. */
import { tl } from "../i18n/shell-i18n.ts";
import type { BrowserState, BrowserTabState } from "../main/browser-state.ts";
import { bridge } from "./bridge.ts";
import { appendChildren, button, el, showToast } from "./dom.ts";
import { cookiesImportedMessage, formatPercent, menuLabels } from "./labels.ts";
import { renderActivityPopover, renderDownloadsPopover } from "./popovers.ts";
import { openSurface, render, run, ui } from "./shell-state.ts";

function tabIcon(tab: BrowserTabState): string {
	if (tab.url === "about:blank") {
		return "◉";
	}
	try {
		return new URL(tab.url).protocol === "https:" ? "◈" : "◌";
	} catch {
		return "◌";
	}
}

function renderTabBar(snapshot: BrowserState): HTMLElement {
	const tabBar = el("div", "tab-bar");
	const tabList = el("div", "tab-list");
	for (const tab of snapshot.tabs) {
		const tabButton = el(
			"div",
			`tab ${tab.id === snapshot.activeId ? "active" : ""}`
		);
		tabButton.setAttribute("role", "tab");
		tabButton.tabIndex = tab.id === snapshot.activeId ? 0 : -1;
		tabButton.title = tab.url;
		tabButton.addEventListener("click", () =>
			run(() => bridge?.select(tab.id) ?? Promise.resolve(snapshot))
		);
		tabButton.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				run(() => bridge?.select(tab.id) ?? Promise.resolve(snapshot));
			}
		});
		appendChildren(
			tabButton,
			el("span", "tab-icon", tabIcon(tab)),
			el("span", "tab-title", tab.title || tl("New tab"))
		);
		const close = button(
			"×",
			"tab-close",
			() => run(() => bridge?.close(tab.id) ?? Promise.resolve(snapshot)),
			tl("Close tab")
		);
		close.addEventListener("click", (event) => event.stopPropagation());
		tabButton.append(close);
		tabList.append(tabButton);
	}
	const newTab = button(
		"+",
		"new-tab",
		() => run(() => bridge?.open() ?? Promise.resolve(snapshot)),
		tl("New tab")
	);
	appendChildren(tabBar, tabList, newTab, el("div", "tab-bar-spacer"));
	return tabBar;
}

function renderAddressForm(snapshot: BrowserState): HTMLElement {
	const addressForm = el("form", "address-form");
	const address = el("input", "address-input");
	address.type = "text";
	address.autocomplete = "off";
	address.spellcheck = false;
	// URLs read left to right; the placeholder follows the shell direction.
	address.dir = "auto";
	address.value =
		snapshot.activeUrl === "about:blank" ? "" : snapshot.activeUrl;
	address.placeholder = tl("Enter a URL or search");
	address.setAttribute("aria-label", tl("Address"));
	// URLs read left to right in every locale.
	address.dir = "ltr";
	addressForm.append(el("span", "address-icon", "◉"), address);
	addressForm.addEventListener("submit", (event) => {
		event.preventDefault();
		const value = address.value.trim();
		if (value) {
			run(
				() => bridge?.navigate(value) ?? Promise.resolve(snapshot),
				tl("Unable to navigate")
			);
		}
	});
	return addressForm;
}

function renderToolbarActions(snapshot: BrowserState): HTMLElement {
	const toolbarActions = el("div", "toolbar-actions");
	const activeActivityCount = snapshot.activities.filter(
		(activity) => activity.status === "active"
	).length;
	const activityButton = button(
		"◒",
		`toolbar-button activity-button ${activeActivityCount > 0 ? "has-active" : ""}`,
		() => {
			ui.activityOpen = !ui.activityOpen;
			ui.menuOpen = false;
			ui.downloadsOpen = false;
			render();
		},
		tl("Activity center")
	);
	if (activeActivityCount > 0) {
		activityButton.append(
			el("span", "activity-count", String(activeActivityCount))
		);
	}
	toolbarActions.append(
		activityButton,
		button(
			"⇩",
			"toolbar-button",
			() => {
				ui.downloadsOpen = !ui.downloadsOpen;
				ui.activityOpen = false;
				ui.menuOpen = false;
				render();
			},
			tl("Downloads")
		),
		button(
			"⋮",
			"toolbar-button menu-trigger",
			() => {
				ui.menuOpen = !ui.menuOpen;
				ui.activityOpen = false;
				ui.downloadsOpen = false;
				render();
			},
			tl("Browser menu")
		)
	);
	return toolbarActions;
}

export function renderBrowser(root: HTMLElement, snapshot: BrowserState): void {
	const shell = el("div", "browser-shell");
	const toolbar = el("div", "browser-toolbar");
	const nav = el("div", "nav-controls");
	const activeTab = snapshot.tabs.find((tab) => tab.id === snapshot.activeId);
	nav.append(
		button(
			"‹",
			`nav-button ${activeTab?.canGoBack ? "" : "disabled"}`,
			() => run(() => bridge?.back() ?? Promise.resolve(snapshot)),
			tl("Back")
		),
		button(
			"›",
			`nav-button ${activeTab?.canGoForward ? "" : "disabled"}`,
			() => run(() => bridge?.forward() ?? Promise.resolve(snapshot)),
			tl("Forward")
		),
		button(
			"↻",
			"nav-button",
			() => run(() => bridge?.reload() ?? Promise.resolve(snapshot)),
			tl("Reload")
		)
	);
	appendChildren(
		toolbar,
		nav,
		renderAddressForm(snapshot),
		renderToolbarActions(snapshot)
	);
	shell.append(renderTabBar(snapshot), toolbar);

	if (ui.findOpen) {
		shell.append(renderFindBar());
	}
	if (ui.downloadsOpen) {
		shell.append(renderDownloadsPopover(snapshot));
	}
	if (ui.activityOpen) {
		shell.append(renderActivityPopover(snapshot));
	}
	if (ui.menuOpen) {
		shell.append(renderMenu(snapshot));
	}
	root.append(shell);
}

function renderFindBar(): HTMLElement {
	const bar = el("form", "find-bar");
	const input = el("input", "find-input");
	input.placeholder = tl("Find in page");
	input.value = ui.findQuery;
	input.autocomplete = "off";
	input.setAttribute("aria-label", tl("Find in page"));
	const count = el(
		"span",
		"find-count",
		ui.findResult.matches > 0
			? `${ui.findResult.activeMatchOrdinal}/${ui.findResult.matches}`
			: ""
	);
	bar.append(
		input,
		count,
		button(
			"×",
			"find-close",
			() => {
				ui.findOpen = false;
				ui.findQuery = "";
				ui.findResult = { activeMatchOrdinal: 0, matches: 0 };
				run(
					() => bridge?.stopFind() ?? Promise.resolve(),
					tl("Unable to close find")
				);
				render();
			},
			tl("Close find")
		)
	);
	input.addEventListener("input", () => {
		ui.findQuery = input.value;
	});
	bar.addEventListener("submit", (event) => {
		event.preventDefault();
		run(
			() => bridge?.find(ui.findQuery) ?? Promise.resolve(),
			tl("Unable to search")
		);
	});
	window.setTimeout(() => input.focus(), 0);
	return bar;
}

function closeMenu(): void {
	ui.menuOpen = false;
	render();
}

function takeScreenshot(): void {
	closeMenu();
	run(async () => {
		const result = await (bridge?.showScreenshot() ??
			Promise.resolve({ saved: false }));
		if (!result.saved) {
			showToast(tl("Screenshot cancelled"));
			return;
		}
		showToast(
			result.path
				? tl("Screenshot saved to {path}", { path: result.path })
				: tl("Screenshot saved to Downloads")
		);
	}, tl("Unable to save screenshot"));
}

/** Import cookies from a browser export and toast the outcome. */
export function importCookies(fallbackError?: string): void {
	run(async () => {
		const result = await (bridge?.importCookies() ??
			Promise.resolve({
				imported: 0,
				message: tl("Browser sidecar unavailable"),
			}));
		showToast(result.message ?? cookiesImportedMessage(result.imported));
	}, fallbackError);
}

function renderMenu(snapshot: BrowserState): HTMLElement {
	const labels = menuLabels();
	const menu = el("div", "browser-menu");
	appendChildren(
		menu,
		menuItem(labels.findInPage, () => {
			ui.menuOpen = false;
			ui.findOpen = true;
			render();
		}),
		menuZoom(snapshot, labels.zoom),
		menuDivider(),
		menuItem(labels.showDeviceToolbar, () => {
			ui.menuOpen = false;
			run(() => bridge?.toggleDeviceToolbar() ?? Promise.resolve(snapshot));
		}),
		menuItem(labels.screenshot, takeScreenshot),
		menuItem(labels.importCookies, () => {
			closeMenu();
			importCookies(tl("Unable to import browser data"));
		}),
		menuItem(labels.passwords, () => openSurface("passwords"), true),
		menuItem(labels.downloads, () => openSurface("downloads")),
		menuItem(labels.history, () => openSurface("history")),
		menuItem(
			labels.clearBrowsingData,
			() => {
				ui.menuOpen = false;
				run(async () => {
					const next = await (bridge?.clearBrowsingData() ??
						Promise.resolve(snapshot));
					showToast(tl("Browsing data cleared"));
					return next;
				}, tl("Unable to clear browsing data"));
			},
			true
		),
		menuDivider(),
		menuItem(labels.browserSettings, () => openSurface("settings"))
	);
	return menu;
}

function menuZoom(snapshot: BrowserState, label: string): HTMLElement {
	const zoomRow = el("div", "menu-row zoom-row");
	zoomRow.append(el("span", "menu-label", label));
	const controls = el("div", "zoom-controls");
	controls.append(
		button(
			"−",
			"zoom-button",
			() => run(() => bridge?.zoom("out") ?? Promise.resolve(snapshot)),
			tl("Zoom out")
		),
		el("span", "zoom-value", formatPercent(zoomPercent(snapshot))),
		button(
			"+",
			"zoom-button",
			() => run(() => bridge?.zoom("in") ?? Promise.resolve(snapshot)),
			tl("Zoom in")
		),
		button(
			"↻",
			"zoom-reset",
			() => run(() => bridge?.zoom("reset") ?? Promise.resolve(snapshot)),
			tl("Reset zoom")
		)
	);
	zoomRow.append(controls);
	return zoomRow;
}

function zoomPercent(snapshot: BrowserState): number {
	return (
		snapshot.tabs.find((tab) => tab.id === snapshot.activeId)?.zoomPercent ??
		100
	);
}

function menuItem(
	label: string,
	onClick: () => void,
	hasSubmenu = false
): HTMLElement {
	const item = button(label, "menu-item", onClick);
	if (hasSubmenu) {
		item.append(el("span", "submenu-chevron", "›"));
	}
	return item;
}

function menuDivider(): HTMLElement {
	return el("div", "menu-divider");
}
