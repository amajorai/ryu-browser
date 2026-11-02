/** Settings sections with their own state: site permissions, extensions, developer mode. */
import { tl } from "../i18n/shell-i18n.ts";
import { browserSitePermissionSchema } from "../main/browser-records.ts";
import type { BrowserState } from "../main/browser-state.ts";
import { bridge } from "./bridge.ts";
import {
	button,
	el,
	sectionHeading,
	selectControl,
	showToast,
	toggle,
} from "./dom.ts";
import { optionLabel } from "./labels.ts";
import { render, run, setState, ui } from "./shell-state.ts";

export function sitePermissionsSection(snapshot: BrowserState): HTMLElement {
	const wrapper = el("section", "site-permissions");
	const heading = sectionHeading(
		tl("Site permissions"),
		button(`＋ ${tl("Add")}`, "text-button", () => {
			ui.sitePermissionFormOpen = !ui.sitePermissionFormOpen;
			render();
		})
	);
	const description = el(
		"p",
		"section-description",
		tl("Override the defaults above for specific sites")
	);
	const body = el("div", "site-permissions-card");
	if (ui.sitePermissionFormOpen) {
		body.append(renderSitePermissionForm(snapshot));
	}
	if (snapshot.settings.sitePermissions.length === 0) {
		body.append(
			el(
				"div",
				"empty-site-permissions",
				tl("No site-specific permissions yet")
			)
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
					`${optionLabel(permission.permission)} · ${optionLabel(permission.decision)}`
				)
			);
			item.append(
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
			body.append(item);
		}
	}
	wrapper.append(heading, description, body);
	return wrapper;
}

function renderSitePermissionForm(snapshot: BrowserState): HTMLElement {
	const form = el("form", "permission-form");
	const origin = el("input", "form-input");
	origin.placeholder = "https://example.com";
	origin.required = true;
	origin.dir = "ltr";
	const permission = selectControl(
		"camera",
		["camera", "microphone", "geolocation", "notifications", "clipboard-read"],
		() => undefined,
		optionLabel
	);
	const decision = selectControl(
		"allow",
		["allow", "deny"],
		() => undefined,
		optionLabel
	);
	const submit = button(tl("Save"), "row-button");
	submit.type = "submit";
	let savePending = false;
	form.append(origin, permission, decision, submit);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (savePending) {
			return;
		}
		try {
			const parsed = new URL(origin.value.trim());
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new Error(tl("Use an http or https site origin"));
			}
			const requestedPermission = browserSitePermissionSchema.parse({
				origin: parsed.origin,
				permission: permission.value,
				decision: decision.value,
			});
			savePending = true;
			submit.disabled = true;
			(
				bridge?.addSitePermission(requestedPermission) ??
				Promise.resolve(snapshot)
			)
				.then((next) => {
					ui.sitePermissionFormOpen = false;
					setState(next);
				})
				.catch((error) => {
					savePending = false;
					submit.disabled = false;
					showToast(
						error instanceof Error
							? error.message
							: tl("Unable to save this site permission")
					);
				});
		} catch (error) {
			showToast(error instanceof Error ? error.message : tl("Invalid origin"));
		}
	});
	return form;
}

export function extensionsSection(snapshot: BrowserState): HTMLElement {
	const wrapper = el("section", "browser-extensions");
	const load = button(tl("Load unpacked"), "text-button", () => {
		run(async () => {
			const next = await (bridge?.chooseExtensionDirectory() ??
				Promise.resolve(null));
			return next ?? snapshot;
		}, tl("Unable to load this extension"));
	});
	wrapper.append(
		sectionHeading(tl("Extensions"), load),
		el(
			"p",
			"section-description",
			tl(
				"Load a trusted unpacked Chrome or Chromium extension into this browser profile."
			)
		)
	);
	const body = el("div", "site-permissions-card extension-list");
	if (snapshot.extensions.length === 0) {
		body.append(
			el(
				"div",
				"empty-site-permissions",
				tl(
					"No extensions installed. The browser accepts unpacked extension folders, not .crx files."
				)
			)
		);
	} else {
		for (const extension of snapshot.extensions) {
			const item = el("div", "permission-item extension-item");
			const copy = el("div", "permission-copy");
			copy.append(
				el("div", "row-label", extension.name),
				el(
					"div",
					"row-description",
					tl("Version {version}", { version: extension.version })
				)
			);
			item.append(
				copy,
				button(tl("Remove"), "row-button", () =>
					run(
						() =>
							bridge?.removeExtension(extension.id) ??
							Promise.resolve(snapshot),
						tl("Unable to remove this extension")
					)
				)
			);
			body.append(item);
		}
	}
	wrapper.append(body);
	return wrapper;
}

export function developerCard(snapshot: BrowserState): HTMLElement {
	const cardNode = el("section", "developer-card");
	const copy = el("div", "developer-copy");
	copy.append(
		el("div", "risk-label", `ⓘ  ${tl("Elevated risk")}`),
		el("div", "row-label", tl("Enable full CDP access")),
		el(
			"div",
			"row-description",
			tl(
				"Allow Ryu to use full Chrome DevTools Protocol (CDP) access in connected browser sessions. Full CDP access lets Ryu inspect and control sensitive browser internals that may put your data at risk."
			)
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
				tl("Restart Ryu Browser for the CDP port change to take effect.")
			)
		);
	}
	return cardNode;
}
