/** The Browser settings page. */
import { tl } from "../i18n/shell-i18n.ts";
import type { BrowserState } from "../main/browser-state.ts";
import { bridge } from "./bridge.ts";
import { importCookies } from "./browser-chrome.ts";
import {
	button,
	card,
	el,
	row,
	sectionHeading,
	selectControl,
	showToast,
	toggle,
} from "./dom.ts";
import { optionLabel } from "./labels.ts";
import { renderPageShell } from "./pages.ts";
import {
	developerCard,
	extensionsSection,
	sitePermissionsSection,
} from "./settings-sections.ts";
import { openSurface, run } from "./shell-state.ts";

function controlCard(snapshot: BrowserState): HTMLElement {
	const controlCardNode = el("section", "control-card");
	const controlCopy = el("div", "control-copy");
	controlCopy.append(
		el("div", "control-title", `◩  ${tl("Browser")}`),
		el("div", "control-description", tl("Let Ryu control the built-in browser"))
	);
	controlCardNode.append(
		controlCopy,
		toggle(snapshot.settings.allowControl, (checked) => {
			run(
				() =>
					bridge?.setSetting("allowControl", checked) ??
					Promise.resolve(snapshot)
			);
		})
	);
	return controlCardNode;
}

function generalCard(snapshot: BrowserState): HTMLElement {
	return card(
		row(
			tl("Web URL and link open destination"),
			tl("Where links open by default"),
			selectControl(
				snapshot.settings.webLinkDestination,
				["default", "ryu"],
				(value) =>
					run(
						() =>
							bridge?.setSetting("webLinkDestination", value) ??
							Promise.resolve(snapshot)
					),
				optionLabel
			)
		),
		row(
			tl("Local URL open destination"),
			tl("Where local development sites open by default"),
			selectControl(
				snapshot.settings.localLinkDestination,
				["ryu", "default"],
				(value) =>
					run(
						() =>
							bridge?.setSetting("localLinkDestination", value) ??
							Promise.resolve(snapshot)
					),
				optionLabel
			)
		),
		row(
			tl("Browsing data"),
			tl(
				"Clear browsing history, site data, cache, and download history from the in-app browser"
			),
			button(`${tl("Clear all browsing data")}  ⌄`, "row-button", () =>
				run(async () => {
					const next = await (bridge?.clearBrowsingData() ??
						Promise.resolve(snapshot));
					showToast(tl("Browsing data cleared"));
					return next;
				})
			)
		),
		row(
			tl("Browsing history"),
			tl("View and manage pages visited in the built-in browser"),
			button(tl("Manage"), "row-button", () => openSurface("history"))
		),
		row(
			tl("Annotation screenshots"),
			tl(
				"Screenshots help Ryu better understand and address comments, but increase plan usage"
			),
			selectControl(
				snapshot.settings.annotationScreenshots,
				["always", "ask", "never"],
				(value) =>
					run(
						() =>
							bridge?.setSetting("annotationScreenshots", value) ??
							Promise.resolve(snapshot)
					),
				optionLabel
			)
		)
	);
}

function autofillCard(): HTMLElement {
	return card(
		row(
			tl("Password manager"),
			tl("Add, delete, and edit saved passwords"),
			button(tl("Manage"), "row-button", () => openSurface("passwords"))
		),
		row(
			tl("Contact info"),
			tl(
				"Add, delete, and edit saved addresses, phone numbers, and email addresses"
			),
			button(tl("Manage"), "row-button", () =>
				showToast(
					tl("Contact info management is ready for the next profile sync")
				)
			)
		)
	);
}

function downloadsCard(snapshot: BrowserState): HTMLElement {
	return card(
		row(
			tl("Location"),
			snapshot.settings.downloadDirectory,
			button(tl("Change"), "row-button", () =>
				run(async () => {
					const next = await (bridge?.chooseDownloadDirectory() ??
						Promise.resolve(null));
					return next ?? snapshot;
				})
			)
		),
		row(
			tl("Ask where to save downloads"),
			tl("Show a save dialog for downloads you start in the built-in browser"),
			toggle(snapshot.settings.askWhereToSave, (checked) =>
				run(
					() =>
						bridge?.setSetting("askWhereToSave", checked) ??
						Promise.resolve(snapshot)
				)
			)
		),
		row(
			tl("Download history"),
			tl("View and manage files downloaded from the built-in browser"),
			button(tl("Manage"), "row-button", () => openSurface("downloads"))
		)
	);
}

function permissionsCard(snapshot: BrowserState): HTMLElement {
	return card(
		row(
			tl("Site settings"),
			tl("Control camera and microphone permissions in the built-in browser"),
			button(tl("Manage"), "row-button", () => openSurface("permissions"))
		),
		row(
			tl("Approval"),
			tl("Choose if Ryu asks for approval before opening websites"),
			selectControl(
				snapshot.settings.approval,
				["always-allow", "always-ask"],
				(value) =>
					run(
						() =>
							bridge?.setSetting("approval", value) ?? Promise.resolve(snapshot)
					),
				optionLabel
			)
		),
		row(
			tl("History"),
			tl("Choose whether Ryu can access your built-in browser history"),
			selectControl(
				snapshot.settings.historyAccess,
				["always-ask", "always-allow"],
				(value) =>
					run(
						() =>
							bridge?.setSetting("historyAccess", value) ??
							Promise.resolve(snapshot)
					),
				optionLabel
			)
		)
	);
}

export function renderSettings(
	root: HTMLElement,
	snapshot: BrowserState
): void {
	const page = renderPageShell(
		tl("Browser"),
		tl(
			"Manage the built-in Chromium browser, permissions, activity, and extensions"
		),
		"browser"
	);
	const content = el("div", "settings-content");
	content.append(controlCard(snapshot));
	const generalImport = button(tl("Import…"), "text-button", () =>
		importCookies()
	);
	content.append(
		sectionHeading(tl("General"), generalImport),
		generalCard(snapshot),
		sectionHeading(tl("Autofill and passwords")),
		autofillCard(),
		sectionHeading(tl("Downloads")),
		downloadsCard(snapshot),
		sectionHeading(tl("Permissions")),
		permissionsCard(snapshot),
		sitePermissionsSection(snapshot),
		extensionsSection(snapshot),
		sectionHeading(tl("Developer mode")),
		developerCard(snapshot)
	);
	page.append(content);
	root.append(page);
}
