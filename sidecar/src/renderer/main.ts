import type {
	BrowserDownloadEntry,
	BrowserHistoryEntry,
	BrowserPermission,
	BrowserSettings,
	BrowserState,
	BrowserSurface,
	BrowserTabState,
	SitePermission,
} from "../main/browser-state.ts";
import { formatBytes } from "../main/browser-state.ts";
import "./styles.css";

interface RyuBrowserBridge {
	addSitePermission(input: SitePermission): Promise<BrowserState>;
	back(): Promise<BrowserState>;
	chooseDownloadDirectory(): Promise<BrowserState | null>;
	clearBrowsingData(): Promise<BrowserState>;
	clearDownloads(): Promise<BrowserState>;
	clearHistory(): Promise<BrowserState>;
	close(id: string): Promise<BrowserState>;
	find(query: string): Promise<void>;
	forward(): Promise<BrowserState>;
	getState(): Promise<BrowserState>;
	importCookies(): Promise<{ imported: number; message?: string }>;
	navigate(url: string): Promise<BrowserState>;
	onFind(
		cb: (result: { activeMatchOrdinal: number; matches: number }) => void
	): () => void;
	onState(cb: (state: BrowserState) => void): () => void;
	open(url?: string): Promise<BrowserState>;
	openDevTools(): Promise<void>;
	openDownloadsFolder(): Promise<void>;
	reload(): Promise<BrowserState>;
	removeSitePermission(
		origin: string,
		permission: BrowserPermission
	): Promise<BrowserState>;
	select(id: string): Promise<BrowserState>;
	setCdpEnabled(enabled: boolean): Promise<BrowserState>;
	setOverlayVisible(visible: boolean): Promise<void>;
	setSetting<K extends keyof BrowserSettings>(
		key: K,
		value: BrowserSettings[K]
	): Promise<BrowserState>;
	setSurface(surface: BrowserSurface): Promise<BrowserState>;
	showScreenshot(): Promise<{ saved: boolean; path?: string }>;
	stopFind(): Promise<void>;
	toggleDeviceToolbar(): Promise<BrowserState>;
	zoom(action: "in" | "out" | "reset"): Promise<BrowserState>;
}

declare global {
	interface Window {
		ryuBrowser?: RyuBrowserBridge;
	}
}

const bridge = window.ryuBrowser;
const root = document.getElementById("app");

let state: BrowserState | null = null;
let menuOpen = false;
let downloadsOpen = false;
let findOpen = false;
let findQuery = "";
let findResult = { activeMatchOrdinal: 0, matches: 0 };
let sitePermissionFormOpen = false;
let toastTimer: number | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

function button(
	label: string,
	className = "icon-button",
	onClick?: () => void,
	ariaLabel = label
): HTMLButtonElement {
	const node = el("button", className, label);
	node.type = "button";
	node.setAttribute("aria-label", ariaLabel);
	if (onClick) {
		node.addEventListener("click", onClick);
	}
	return node;
}

function appendChildren(
	parent: HTMLElement,
	...children: (Node | null)[]
): void {
	for (const child of children) {
		if (child) {
			parent.append(child);
		}
	}
}

function currentState(): BrowserState {
	return (
		state ?? {
			activeId: null,
			activeTitle: "",
			activeUrl: "about:blank",
			cdpRestartRequired: false,
			deviceToolbar: false,
			downloads: [],
			history: [],
			settings: {
				allowControl: true,
				annotationScreenshots: "always",
				approval: "always-allow",
				askWhereToSave: false,
				developerCdp: false,
				downloadDirectory: "System Downloads folder",
				historyAccess: "always-ask",
				localLinkDestination: "ryu",
				sitePermissions: [],
				webLinkDestination: "default",
			},
			surface: "browser",
			tabs: [],
		}
	);
}

function setState(next: BrowserState): void {
	state = next;
	render();
}

function run(
	action: () => Promise<BrowserState> | Promise<void>,
	message = "Something went wrong"
): void {
	action()
		.then((next) => {
			if (next && typeof next === "object" && "tabs" in next) {
				setState(next as BrowserState);
			}
		})
		.catch((error: unknown) => {
			showToast(error instanceof Error ? error.message : message);
		});
}

function showToast(message: string): void {
	const existing = document.querySelector(".toast");
	existing?.remove();
	const toast = el("div", "toast", message);
	document.body.append(toast);
	if (toastTimer !== undefined) {
		window.clearTimeout(toastTimer);
	}
	toastTimer = window.setTimeout(() => toast.remove(), 3600);
}

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

function render(): void {
	if (bridge) {
		void bridge
			.setOverlayVisible(menuOpen || downloadsOpen || findOpen)
			.catch(() => undefined);
	}
	if (!root) {
		return;
	}
	root.replaceChildren();
	const snapshot = currentState();
	if (snapshot.surface === "browser") {
		renderBrowser(snapshot);
		return;
	}
	if (snapshot.surface === "settings") {
		renderSettings(snapshot);
		return;
	}
	if (snapshot.surface === "history") {
		renderHistory(snapshot);
		return;
	}
	if (snapshot.surface === "downloads") {
		renderDownloads(snapshot);
		return;
	}
	if (snapshot.surface === "passwords") {
		renderPasswords(snapshot);
		return;
	}
	renderPermissions(snapshot);
}

function renderBrowser(snapshot: BrowserState): void {
	const shell = el("div", "browser-shell");
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
			el("span", "tab-title", tab.title || "New tab")
		);
		const close = button(
			"×",
			"tab-close",
			() => run(() => bridge?.close(tab.id) ?? Promise.resolve(snapshot)),
			"Close tab"
		);
		close.addEventListener("click", (event) => event.stopPropagation());
		tabButton.append(close);
		tabList.append(tabButton);
	}
	const newTab = button(
		"+",
		"new-tab",
		() => run(() => bridge?.open() ?? Promise.resolve(snapshot)),
		"New tab"
	);
	appendChildren(tabBar, tabList, newTab, el("div", "tab-bar-spacer"));

	const toolbar = el("div", "browser-toolbar");
	const nav = el("div", "nav-controls");
	const activeTab = snapshot.tabs.find((tab) => tab.id === snapshot.activeId);
	nav.append(
		button(
			"‹",
			`nav-button ${activeTab?.canGoBack ? "" : "disabled"}`,
			() => run(() => bridge?.back() ?? Promise.resolve(snapshot)),
			"Back"
		),
		button(
			"›",
			`nav-button ${activeTab?.canGoForward ? "" : "disabled"}`,
			() => run(() => bridge?.forward() ?? Promise.resolve(snapshot)),
			"Forward"
		),
		button(
			"↻",
			"nav-button",
			() => run(() => bridge?.reload() ?? Promise.resolve(snapshot)),
			"Reload"
		)
	);
	const addressForm = el("form", "address-form");
	const address = el("input", "address-input") as HTMLInputElement;
	address.type = "text";
	address.autocomplete = "off";
	address.spellcheck = false;
	address.value =
		snapshot.activeUrl === "about:blank" ? "" : snapshot.activeUrl;
	address.placeholder = "Enter a URL or search";
	address.setAttribute("aria-label", "Address");
	addressForm.append(el("span", "address-icon", "◉"), address);
	addressForm.addEventListener("submit", (event) => {
		event.preventDefault();
		const value = address.value.trim();
		if (value) {
			run(
				() => bridge?.navigate(value) ?? Promise.resolve(snapshot),
				"Unable to navigate"
			);
		}
	});
	const toolbarActions = el("div", "toolbar-actions");
	toolbarActions.append(
		button(
			"⇩",
			"toolbar-button",
			() => {
				downloadsOpen = !downloadsOpen;
				menuOpen = false;
				render();
			},
			"Downloads"
		),
		button(
			"⋮",
			"toolbar-button menu-trigger",
			() => {
				menuOpen = !menuOpen;
				downloadsOpen = false;
				render();
			},
			"Browser menu"
		)
	);
	appendChildren(toolbar, nav, addressForm, toolbarActions);
	shell.append(tabBar, toolbar);

	if (findOpen) {
		shell.append(renderFindBar());
	}
	if (downloadsOpen) {
		shell.append(renderDownloadsPopover(snapshot));
	}
	if (menuOpen) {
		shell.append(renderMenu(snapshot));
	}
	root?.append(shell);
}

function renderFindBar(): HTMLElement {
	const bar = el("form", "find-bar");
	const input = el("input", "find-input") as HTMLInputElement;
	input.placeholder = "Find in page";
	input.value = findQuery;
	input.autocomplete = "off";
	input.setAttribute("aria-label", "Find in page");
	const count = el(
		"span",
		"find-count",
		findResult.matches > 0
			? `${findResult.activeMatchOrdinal}/${findResult.matches}`
			: ""
	);
	bar.append(
		input,
		count,
		button(
			"×",
			"find-close",
			() => {
				findOpen = false;
				findQuery = "";
				findResult = { activeMatchOrdinal: 0, matches: 0 };
				run(
					() => bridge?.stopFind() ?? Promise.resolve(),
					"Unable to close find"
				);
				render();
			},
			"Close find"
		)
	);
	input.addEventListener("input", () => {
		findQuery = input.value;
	});
	bar.addEventListener("submit", (event) => {
		event.preventDefault();
		run(() => bridge?.find(findQuery) ?? Promise.resolve(), "Unable to search");
	});
	window.setTimeout(() => input.focus(), 0);
	return bar;
}

function renderMenu(snapshot: BrowserState): HTMLElement {
	const menu = el("div", "browser-menu");
	appendChildren(
		menu,
		menuItem("Find in page", () => {
			menuOpen = false;
			findOpen = true;
			render();
		}),
		menuZoom(snapshot),
		menuDivider(),
		menuItem("Show device toolbar", () => {
			menuOpen = false;
			run(() => bridge?.toggleDeviceToolbar() ?? Promise.resolve(snapshot));
		}),
		menuItem("Take a screenshot", () => {
			menuOpen = false;
			run(async () => {
				const result = await (bridge?.showScreenshot() ??
					Promise.resolve({ saved: false }));
				showToast(
					result.saved
						? `Screenshot saved to ${result.path ?? "Downloads"}`
						: "Screenshot cancelled"
				);
			}, "Unable to save screenshot");
		}),
		menuItem("Import cookies…", () => {
			menuOpen = false;
			run(async () => {
				const result = await (bridge?.importCookies() ??
					Promise.resolve({
						imported: 0,
						message: "Browser sidecar unavailable",
					}));
				showToast(result.message ?? `${result.imported} cookies imported`);
			}, "Unable to import browser data");
		}),
		menuItem("Passwords and autofill", () => openSurface("passwords"), true),
		menuItem("Downloads", () => openSurface("downloads")),
		menuItem("History", () => openSurface("history")),
		menuItem(
			"Clear browsing data",
			() => {
				menuOpen = false;
				run(async () => {
					const next = await (bridge?.clearBrowsingData() ??
						Promise.resolve(snapshot));
					showToast("Browsing data cleared");
					return next;
				}, "Unable to clear browsing data");
			},
			true
		),
		menuDivider(),
		menuItem("Browser settings", () => openSurface("settings"))
	);
	return menu;
}

function menuZoom(snapshot: BrowserState): HTMLElement {
	const row = el("div", "menu-row zoom-row");
	row.append(el("span", "menu-label", "Zoom"));
	const controls = el("div", "zoom-controls");
	controls.append(
		button(
			"−",
			"zoom-button",
			() => run(() => bridge?.zoom("out") ?? Promise.resolve(snapshot)),
			"Zoom out"
		),
		el("span", "zoom-value", `${zoomPercent(snapshot)}%`),
		button(
			"+",
			"zoom-button",
			() => run(() => bridge?.zoom("in") ?? Promise.resolve(snapshot)),
			"Zoom in"
		),
		button(
			"↻",
			"zoom-reset",
			() => run(() => bridge?.zoom("reset") ?? Promise.resolve(snapshot)),
			"Reset zoom"
		)
	);
	row.append(controls);
	return row;
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

function renderDownloadsPopover(snapshot: BrowserState): HTMLElement {
	const popover = el("div", "downloads-popover");
	const header = el("div", "popover-header");
	header.append(
		el("span", "popover-title", "Downloads"),
		button(
			"⌂",
			"popover-icon",
			() => run(() => bridge?.openDownloadsFolder() ?? Promise.resolve()),
			"Open downloads folder"
		)
	);
	const list = el("div", "download-list");
	if (snapshot.downloads.length === 0) {
		list.append(el("div", "empty-popover", "No downloads yet"));
	} else {
		for (const download of snapshot.downloads.slice(0, 5)) {
			list.append(renderDownloadRow(download, true));
		}
	}
	popover.append(header, list);
	return popover;
}

function renderDownloadRow(
	download: BrowserDownloadEntry,
	compact = false
): HTMLElement {
	const row = el("div", compact ? "download-row compact" : "download-row");
	const fileIcon = el(
		"span",
		"download-file-icon",
		fileExtension(download.filename) === "json" ? "{}" : "▧"
	);
	const details = el("div", "download-details");
	details.append(el("div", "download-name", download.filename || "Download"));
	const status =
		download.state === "completed"
			? formatBytes(download.totalBytes)
			: download.state === "progressing"
				? `${download.percent}%`
				: download.state;
	details.append(
		el(
			"div",
			"download-status",
			`${status} · ${fileNameForPath(download.path)}`
		)
	);
	const more = button(
		"…",
		"download-more",
		() => showToast("Download actions are available from Download history"),
		"Download actions"
	);
	row.append(fileIcon, details, more);
	return row;
}

function fileExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function fileNameForPath(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts.at(-1) || "Saved locally";
}

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
		"Back to browser"
	);
	const copy = el("div", "page-heading");
	copy.append(
		el("h1", "page-title", title),
		el("p", "page-subtitle", subtitle)
	);
	header.append(back, copy);
	return header;
}

function renderPageShell(
	title: string,
	subtitle: string,
	backTo: BrowserSurface
): HTMLElement {
	const page = el("div", "full-page");
	page.append(renderPageHeader(title, subtitle, backTo));
	return page;
}

function renderSettings(snapshot: BrowserState): void {
	const page = renderPageShell(
		"Browser",
		"Manage the built-in browser. Browser extensions can be set up in computer use settings",
		"browser"
	);
	const content = el("div", "settings-content");
	const controlCard = el("section", "control-card");
	const controlCopy = el("div", "control-copy");
	controlCopy.append(
		el("div", "control-title", "◩  Browser"),
		el("div", "control-description", "Let Ryu control the built-in browser")
	);
	controlCard.append(
		controlCopy,
		toggle(snapshot.settings.allowControl, (checked) => {
			run(
				() =>
					bridge?.setSetting("allowControl", checked) ??
					Promise.resolve(snapshot)
			);
		})
	);
	content.append(controlCard);

	const generalImport = button("Import…", "text-button", () => {
		run(async () => {
			const result = await (bridge?.importCookies() ??
				Promise.resolve({
					imported: 0,
					message: "Browser sidecar unavailable",
				}));
			showToast(result.message ?? `${result.imported} cookies imported`);
		});
	});
	const generalCard = card(
		row(
			"Web URL and link open destination",
			"Where links open by default",
			selectControl(
				snapshot.settings.webLinkDestination,
				["default", "ryu"],
				(value) =>
					run(
						() =>
							bridge?.setSetting(
								"webLinkDestination",
								value as BrowserSettings["webLinkDestination"]
							) ?? Promise.resolve(snapshot)
					)
			)
		),
		row(
			"Local URL open destination",
			"Where local development sites open by default",
			selectControl(
				snapshot.settings.localLinkDestination,
				["ryu", "default"],
				(value) =>
					run(
						() =>
							bridge?.setSetting(
								"localLinkDestination",
								value as BrowserSettings["localLinkDestination"]
							) ?? Promise.resolve(snapshot)
					)
			)
		),
		row(
			"Browsing data",
			"Clear browsing history, site data, cache, and download history from the in-app browser",
			button("Clear all browsing data  ⌄", "row-button", () =>
				run(async () => {
					const next = await (bridge?.clearBrowsingData() ??
						Promise.resolve(snapshot));
					showToast("Browsing data cleared");
					return next;
				})
			)
		),
		row(
			"Browsing history",
			"View and manage pages visited in the built-in browser",
			button("Manage", "row-button", () => openSurface("history"))
		),
		row(
			"Annotation screenshots",
			"Screenshots help Ryu better understand and address comments, but increase plan usage",
			selectControl(
				snapshot.settings.annotationScreenshots,
				["always", "ask", "never"],
				(value) =>
					run(
						() =>
							bridge?.setSetting(
								"annotationScreenshots",
								value as BrowserSettings["annotationScreenshots"]
							) ?? Promise.resolve(snapshot)
					)
			)
		)
	);
	content.append(sectionHeading("General", generalImport), generalCard);
	content.append(
		sectionHeading("Autofill and passwords"),
		card(
			row(
				"Password manager",
				"Add, delete, and edit saved passwords",
				button("Manage", "row-button", () => openSurface("passwords"))
			),
			row(
				"Contact info",
				"Add, delete, and edit saved addresses, phone numbers, and email addresses",
				button("Manage", "row-button", () =>
					showToast(
						"Contact info management is ready for the next profile sync"
					)
				)
			)
		),
		sectionHeading("Downloads"),
		card(
			row(
				"Location",
				snapshot.settings.downloadDirectory,
				button("Change", "row-button", () =>
					run(async () => {
						const next = await (bridge?.chooseDownloadDirectory() ??
							Promise.resolve(null));
						return next ?? snapshot;
					})
				)
			),
			row(
				"Ask where to save downloads",
				"Show a save dialog for downloads you start in the built-in browser",
				toggle(snapshot.settings.askWhereToSave, (checked) =>
					run(
						() =>
							bridge?.setSetting("askWhereToSave", checked) ??
							Promise.resolve(snapshot)
					)
				)
			),
			row(
				"Download history",
				"View and manage files downloaded from the built-in browser",
				button("Manage", "row-button", () => openSurface("downloads"))
			)
		),
		sectionHeading("Permissions"),
		card(
			row(
				"Site settings",
				"Control camera and microphone permissions in the built-in browser",
				button("Manage", "row-button", () => openSurface("permissions"))
			),
			row(
				"Approval",
				"Choose if Ryu asks for approval before opening websites",
				selectControl(
					snapshot.settings.approval,
					["always-allow", "always-ask"],
					(value) =>
						run(
							() =>
								bridge?.setSetting(
									"approval",
									value as BrowserSettings["approval"]
								) ?? Promise.resolve(snapshot)
						)
				)
			),
			row(
				"History",
				"Choose whether Ryu can access your built-in browser history",
				selectControl(
					snapshot.settings.historyAccess,
					["always-ask", "always-allow"],
					(value) =>
						run(
							() =>
								bridge?.setSetting(
									"historyAccess",
									value as BrowserSettings["historyAccess"]
								) ?? Promise.resolve(snapshot)
						)
				)
			)
		),
		sitePermissionsSection(snapshot),
		sectionHeading("Developer mode"),
		developerCard(snapshot)
	);
	page.append(content);
	root?.append(page);
}

function sectionHeading(title: string, action?: HTMLElement): HTMLElement {
	const heading = el("div", "section-heading");
	heading.append(el("h2", "section-title", title));
	if (action) {
		heading.append(action);
	}
	return heading;
}

function card(...rows: HTMLElement[]): HTMLElement {
	const node = el("section", "settings-card");
	for (const row of rows) {
		node.append(row);
	}
	return node;
}

function row(
	label: string,
	description: string,
	control: HTMLElement
): HTMLElement {
	const node = el("div", "settings-row");
	const copy = el("div", "row-copy");
	copy.append(
		el("div", "row-label", label),
		el("div", "row-description", description)
	);
	node.append(copy, control);
	return node;
}

function selectControl<T extends string>(
	value: T,
	options: T[],
	onChange: (value: string) => void
): HTMLSelectElement {
	const select = el("select", "select-control") as HTMLSelectElement;
	for (const option of options) {
		const item = el("option", undefined, optionLabel(option));
		item.value = option;
		item.selected = option === value;
		select.append(item);
	}
	select.addEventListener("change", () => onChange(select.value));
	return select;
}

function optionLabel(value: string): string {
	return value
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function toggle(
	checked: boolean,
	onChange: (checked: boolean) => void
): HTMLButtonElement {
	const control = button(
		"",
		`toggle ${checked ? "on" : ""}`,
		() => {
			onChange(!checked);
		},
		checked ? "On" : "Off"
	);
	control.setAttribute("aria-checked", String(checked));
	control.setAttribute("role", "switch");
	control.append(el("span", "toggle-knob"));
	return control;
}

function sitePermissionsSection(snapshot: BrowserState): HTMLElement {
	const wrapper = el("section", "site-permissions");
	const heading = sectionHeading(
		"Site permissions",
		button("＋ Add", "text-button", () => {
			sitePermissionFormOpen = !sitePermissionFormOpen;
			render();
		})
	);
	const description = el(
		"p",
		"section-description",
		"Override the defaults above for specific sites"
	);
	const body = el("div", "site-permissions-card");
	if (sitePermissionFormOpen) {
		body.append(renderSitePermissionForm(snapshot));
	}
	if (snapshot.settings.sitePermissions.length === 0) {
		body.append(
			el("div", "empty-site-permissions", "No site-specific permissions yet")
		);
	} else {
		for (const permission of snapshot.settings.sitePermissions) {
			const item = el("div", "permission-item");
			const copy = el("div", "permission-copy");
			copy.append(
				el("div", "row-label", permission.origin),
				el(
					"div",
					"row-description",
					`${permission.permission} · ${permission.decision}`
				)
			);
			item.append(
				copy,
				button("Remove", "row-button", () =>
					run(
						() =>
							bridge?.removeSitePermission(
								permission.origin,
								permission.permission
							) ?? Promise.resolve(snapshot)
					)
				)
			);
			body.append(item);
		}
	}
	wrapper.append(heading, description, body);
	return wrapper;
}

function renderSitePermissionForm(snapshot: BrowserState): HTMLElement {
	const form = el("form", "permission-form");
	const origin = el("input", "form-input") as HTMLInputElement;
	origin.placeholder = "https://example.com";
	origin.required = true;
	const permission = selectControl(
		"camera" as BrowserPermission,
		["camera", "microphone", "geolocation", "notifications", "clipboard-read"],
		() => undefined
	);
	const decision = selectControl("allow", ["allow", "deny"], () => undefined);
	const submit = button("Save", "row-button");
	submit.type = "submit";
	form.append(origin, permission, decision, submit);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		try {
			const parsed = new URL(origin.value.trim());
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error("Use an http or https site origin");
			}
			sitePermissionFormOpen = false;
			run(
				() =>
					bridge?.addSitePermission({
						origin: parsed.origin,
						permission: permission.value as BrowserPermission,
						decision: decision.value as "allow" | "deny",
					}) ?? Promise.resolve(snapshot)
			);
		} catch (error) {
			showToast(error instanceof Error ? error.message : "Invalid origin");
		}
	});
	return form;
}

function developerCard(snapshot: BrowserState): HTMLElement {
	const cardNode = el("section", "developer-card");
	const copy = el("div", "developer-copy");
	copy.append(
		el("div", "risk-label", "ⓘ  Elevated risk"),
		el("div", "row-label", "Enable full CDP access"),
		el(
			"div",
			"row-description",
			"Allow Ryu to use full Chrome DevTools Protocol (CDP) access in connected browser sessions. Full CDP access lets Ryu inspect and control sensitive browser internals that may put your data at risk."
		)
	);
	const cdpToggle = toggle(snapshot.settings.developerCdp, (checked) => {
		run(() => bridge?.setCdpEnabled(checked) ?? Promise.resolve(snapshot));
	});
	cardNode.append(copy, cdpToggle);
	if (snapshot.cdpRestartRequired) {
		cardNode.append(
			el(
				"div",
				"restart-note",
				"Restart Ryu Browser for the CDP port change to take effect."
			)
		);
	}
	return cardNode;
}

function renderHistory(snapshot: BrowserState): void {
	const page = renderPageShell(
		"Browsing history",
		"Pages visited in the built-in browser",
		"browser"
	);
	const actions = el("div", "page-actions");
	actions.append(
		button("Clear history", "text-button", () =>
			run(async () => {
				const next = await (bridge?.clearHistory() ??
					Promise.resolve(snapshot));
				showToast("Browsing history cleared");
				return next;
			})
		)
	);
	page.querySelector(".page-header")?.append(actions);
	const list = el("div", "history-list");
	if (snapshot.history.length === 0) {
		list.append(
			el("div", "empty-state", "No pages in your browsing history yet.")
		);
	} else {
		for (const entry of snapshot.history) {
			list.append(renderHistoryRow(entry, snapshot));
		}
	}
	page.append(list);
	root?.append(page);
}

function renderHistoryRow(
	entry: BrowserHistoryEntry,
	snapshot: BrowserState
): HTMLElement {
	const rowNode = el("div", "history-row");
	const copy = el("div", "history-copy");
	copy.append(
		el("div", "history-title", entry.title || "Untitled"),
		el("div", "history-url", entry.url),
		el("div", "history-time", new Date(entry.visitedAt).toLocaleString())
	);
	const open = button("Open", "row-button", () => {
		run(async () => {
			const next = await (bridge?.open(entry.url) ?? Promise.resolve(snapshot));
			return next;
		});
	});
	rowNode.append(copy, open);
	return rowNode;
}

function renderDownloads(snapshot: BrowserState): void {
	const page = renderPageShell(
		"Downloads",
		"Files downloaded from the built-in browser",
		"browser"
	);
	const actions = el("div", "page-actions");
	actions.append(
		button("Open folder", "text-button", () =>
			run(() => bridge?.openDownloadsFolder() ?? Promise.resolve())
		)
	);
	actions.append(
		button("Clear history", "text-button", () =>
			run(async () => {
				const next = await (bridge?.clearDownloads() ??
					Promise.resolve(snapshot));
				showToast("Download history cleared");
				return next;
			})
		)
	);
	page.querySelector(".page-header")?.append(actions);
	const list = el("div", "downloads-page-list");
	if (snapshot.downloads.length === 0) {
		list.append(el("div", "empty-state", "No downloads yet."));
	} else {
		for (const download of snapshot.downloads) {
			list.append(renderDownloadRow(download));
		}
	}
	page.append(list);
	root?.append(page);
}

function renderPasswords(_snapshot: BrowserState): void {
	const page = renderPageShell(
		"Passwords and autofill",
		"Manage the credentials and contact details used by the built-in browser",
		"settings"
	);
	const notice = el("section", "info-card");
	notice.append(
		el("div", "info-icon", "▣"),
		el(
			"div",
			"info-copy",
			"Ryu never exposes saved passwords to agents or stores them in browser history. Connect an OS password manager to enable encrypted autofill."
		)
	);
	page.append(
		notice,
		sectionHeading("Password manager"),
		card(
			row(
				"Saved passwords",
				"Credentials stay masked and local to the browser profile",
				button("Add password", "row-button", () =>
					showToast(
						"Password manager connection is required before adding credentials"
					)
				)
			)
		),
		sectionHeading("Contact info"),
		card(
			row(
				"Saved addresses",
				"Use your system contact store for autofill",
				button("Manage", "row-button", () =>
					showToast(
						"Contact info management is ready for the next profile sync"
					)
				)
			)
		)
	);
	root?.append(page);
}

function renderPermissions(snapshot: BrowserState): void {
	const page = renderPageShell(
		"Site settings",
		"Control permissions granted to websites in the built-in browser",
		"settings"
	);
	const list = el("div", "permission-page-list");
	const permissions = snapshot.settings.sitePermissions;
	if (permissions.length === 0) {
		list.append(
			el(
				"div",
				"empty-state",
				"No site-specific permissions yet. Add an override from Browser settings."
			)
		);
	} else {
		for (const permission of permissions) {
			list.append(renderPermissionPageRow(permission, snapshot));
		}
	}
	page.append(list);
	root?.append(page);
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
			`${permission.permission} · ${permission.decision}`
		)
	);
	rowNode.append(
		copy,
		button("Remove", "row-button", () =>
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

function openSurface(surface: BrowserSurface): void {
	menuOpen = false;
	downloadsOpen = false;
	findOpen = false;
	run(() => bridge?.setSurface(surface) ?? Promise.resolve(currentState()));
}

if (bridge) {
	bridge
		.getState()
		.then(setState)
		.catch(() => render());
	bridge.onState(setState);
	bridge.onFind((result) => {
		findResult = result;
		render();
	});
} else {
	render();
}
