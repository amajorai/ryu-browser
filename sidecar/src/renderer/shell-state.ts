/**
 * The shell renderer's state: the last browser snapshot from the main process,
 * which popovers are open, and the `run`/`render` plumbing every view uses.
 * `main.ts` registers the top-level renderer with `setRenderer`.
 */
import { tl } from "../i18n/shell-i18n.ts";
import type { BrowserState, BrowserSurface } from "../main/browser-state.ts";
import { bridge } from "./bridge.ts";
import { showToast } from "./dom.ts";

export const ui = {
	activityOpen: false,
	downloadsOpen: false,
	findOpen: false,
	findQuery: "",
	findResult: { activeMatchOrdinal: 0, matches: 0 },
	menuOpen: false,
	sitePermissionFormOpen: false,
};

let state: BrowserState | null = null;
let renderer: () => void = () => undefined;

export function setRenderer(next: () => void): void {
	renderer = next;
}

export function render(): void {
	renderer();
}

export function currentState(): BrowserState {
	return (
		state ?? {
			activeId: null,
			activeTitle: "",
			activeUrl: "about:blank",
			activities: [],
			cdpRestartRequired: false,
			deviceToolbar: false,
			downloads: [],
			extensions: [],
			history: [],
			settings: {
				allowControl: true,
				annotationScreenshots: "always",
				approval: "always-allow",
				askWhereToSave: false,
				developerCdp: false,
				downloadDirectory: tl("System Downloads folder"),
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

export function setState(next: BrowserState): void {
	state = next;
	render();
}

export function run(
	action: () => Promise<BrowserState> | Promise<void>,
	message = tl("Something went wrong")
): void {
	action()
		.then((next) => {
			if (next) {
				setState(next);
			}
		})
		.catch((error) => {
			showToast(error instanceof Error ? error.message : message);
		});
}

export function openSurface(surface: BrowserSurface): void {
	ui.menuOpen = false;
	ui.downloadsOpen = false;
	ui.activityOpen = false;
	ui.findOpen = false;
	run(() => bridge?.setSurface(surface) ?? Promise.resolve(currentState()));
}
