/** Full-page surfaces: history, downloads, passwords, and site settings. */
import { tl } from "../i18n/shell-i18n.ts";
import type {
	BrowserHistoryEntry,
	BrowserState,
	BrowserSurface,
	SitePermission,
} from "../main/browser-state.ts";
import { formatRelativeTime } from "../main/browser-state.ts";
import { bridge } from "./bridge.ts";
import { button, card, el, row, sectionHeading, showToast } from "./dom.ts";
import { optionLabel } from "./labels.ts";
import { renderDownloadRow } from "./popovers.ts";
import { openSurface, run } from "./shell-state.ts";

function renderPageHeader(
	title: string,
	subtitle: string,
	backTo: BrowserSurface
): HTMLElement {
	const header = el("header", "page-header");
	const back = button(
		"‹",
		"page-back",
		() => openSurface(backTo),
		tl("Back to browser")
	);
	const copy = el("div", "page-heading");
	copy.append(
		el("h1", "page-title", title),
		el("p", "page-subtitle", subtitle)
	);
	header.append(back, copy);
	return header;
}

export function renderPageShell(
	title: string,
	subtitle: string,
	backTo: BrowserSurface
): HTMLElement {
	const page = el("div", "full-page");
	page.append(renderPageHeader(title, subtitle, backTo));
	return page;
}

export function renderHistory(root: HTMLElement, snapshot: BrowserState): void {
	const page = renderPageShell(
		tl("Browsing history"),
		tl("Pages visited in the built-in browser"),
		"browser"
	);
	const actions = el("div", "page-actions");
	actions.append(
		button(tl("Clear history"), "text-button", () =>
			run(async () => {
				const next = await (bridge?.clearHistory() ??
					Promise.resolve(snapshot));
				showToast(tl("Browsing history cleared"));
				return next;
			})
		)
	);
	page.querySelector(".page-header")?.append(actions);
	const list = el("div", "history-list");
	if (snapshot.history.length === 0) {
		list.append(
			el("div", "empty-state", tl("No pages in your browsing history yet."))
		);
	} else {
		for (const entry of snapshot.history) {
			list.append(renderHistoryRow(entry, snapshot));
		}
	}
	page.append(list);
	root.append(page);
}

function renderHistoryRow(
	entry: BrowserHistoryEntry,
	snapshot: BrowserState
): HTMLElement {
	const rowNode = el("div", "history-row");
	const copy = el("div", "history-copy");
	const url = el("div", "history-url", entry.url);
	url.dir = "ltr";
	copy.append(
		el("div", "history-title", entry.title || tl("Untitled")),
		url,
		el("div", "history-time", formatRelativeTime(entry.visitedAt))
	);
	const open = button(tl("Open"), "row-button", () => {
		run(async () => {
			const next = await (bridge?.open(entry.url) ?? Promise.resolve(snapshot));
			return next.surface === "browser"
				? next
				: (bridge?.setSurface("browser") ?? Promise.resolve(next));
		});
	});
	rowNode.append(copy, open);
	return rowNode;
}

export function renderDownloads(
	root: HTMLElement,
	snapshot: BrowserState
): void {
	const page = renderPageShell(
		tl("Downloads"),
		tl("Files downloaded from the built-in browser"),
		"browser"
	);
	const actions = el("div", "page-actions");
	actions.append(
		button(tl("Open folder"), "text-button", () =>
			run(() => bridge?.openDownloadsFolder() ?? Promise.resolve())
		)
	);
	actions.append(
		button(tl("Clear history"), "text-button", () =>
			run(async () => {
				const next = await (bridge?.clearDownloads() ??
					Promise.resolve(snapshot));
				showToast(tl("Download history cleared"));
				return next;
			})
		)
	);
	page.querySelector(".page-header")?.append(actions);
	const list = el("div", "downloads-page-list");
	if (snapshot.downloads.length === 0) {
		list.append(el("div", "empty-state", tl("No downloads yet.")));
	} else {
		for (const download of snapshot.downloads) {
			list.append(renderDownloadRow(download));
		}
	}
	page.append(list);
	root.append(page);
}

export function renderPasswords(root: HTMLElement): void {
	const page = renderPageShell(
		tl("Passwords and autofill"),
		tl(
			"Manage the credentials and contact details used by the built-in browser"
		),
		"settings"
	);
	const notice = el("section", "info-card");
	notice.append(
		el("div", "info-icon", "▣"),
		el(
			"div",
			"info-copy",
			tl(
				"Ryu never exposes saved passwords to agents or stores them in browser history. Connect an OS password manager to enable encrypted autofill."
			)
		)
	);
	page.append(
		notice,
		sectionHeading(tl("Password manager")),
		card(
			row(
				tl("Saved passwords"),
				tl("Credentials stay masked and local to the browser profile"),
				button(tl("Add password"), "row-button", () =>
					showToast(
						tl(
							"Password manager connection is required before adding credentials"
						)
					)
				)
			)
		),
		sectionHeading(tl("Contact info")),
		card(
			row(
				tl("Saved addresses"),
				tl("Use your system contact store for autofill"),
				button(tl("Manage"), "row-button", () =>
					showToast(
						tl("Contact info management is ready for the next profile sync")
					)
				)
			)
		)
	);
	root.append(page);
}

export function renderPermissions(
	root: HTMLElement,
	snapshot: BrowserState
): void {
	const page = renderPageShell(
		tl("Site settings"),
		tl("Control permissions granted to websites in the built-in browser"),
		"settings"
	);
	const list = el("div", "permission-page-list");
	const permissions = snapshot.settings.sitePermissions;
	if (permissions.length === 0) {
		list.append(
			el(
				"div",
				"empty-state",
				tl(
					"No site-specific permissions yet. Add an override from Browser settings."
				)
			)
		);
	} else {
		for (const permission of permissions) {
			list.append(renderPermissionPageRow(permission, snapshot));
		}
	}
	page.append(list);
	root.append(page);
}

function renderPermissionPageRow(
	permission: SitePermission,
	snapshot: BrowserState
): HTMLElement {
	const rowNode = el("div", "history-row");
	const copy = el("div", "history-copy");
	copy.append(
		el("div", "history-title", permission.origin),
		el(
			"div",
			"history-url",
			`${optionLabel(permission.permission)} · ${optionLabel(permission.decision)}`
		)
	);
	rowNode.append(
		copy,
		button(tl("Remove"), "row-button", () =>
			run(
				() =>
					bridge?.removeSitePermission(
						permission.origin,
						permission.permission
					) ?? Promise.resolve(snapshot)
			)
		)
	);
	return rowNode;
}
