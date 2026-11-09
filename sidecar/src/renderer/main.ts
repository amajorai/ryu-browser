import "@fontsource-variable/inter";
import "./styles.css";
import { bridge } from "./bridge.ts";
import { renderBrowser } from "./browser-chrome.ts";
import { adoptShellLocale, themeLocale } from "./locale.ts";
import {
	renderDownloads,
	renderHistory,
	renderPasswords,
	renderPermissions,
} from "./pages.ts";
import { renderSettings } from "./settings-page.ts";
import {
	currentState,
	render,
	setRenderer,
	setState,
	ui,
} from "./shell-state.ts";

const root = document.getElementById("app");

adoptShellLocale(
	bridge?.locale ?? navigator.language,
	document.documentElement
);

/** Apply theme tokens; returns whether they switched the shell locale. */
function applyThemeTokens(tokens: Record<string, string>): boolean {
	for (const [name, value] of Object.entries(tokens)) {
		if (
			/^--[a-zA-Z0-9_-]{1,100}$/.test(name) &&
			value.length > 0 &&
			![...value].some((character) => "{}<>;".includes(character))
		) {
			document.documentElement.style.setProperty(name, value);
		}
	}
	return adoptShellLocale(themeLocale(tokens), document.documentElement);
}

void bridge
	?.getTheme()
	.then((tokens) => {
		if (applyThemeTokens(tokens)) {
			render();
		}
	})
	.catch(() => undefined);
const removeThemeListener = bridge?.onTheme((tokens) => {
	applyThemeTokens(tokens);
	render();
});
window.addEventListener("beforeunload", () => removeThemeListener?.(), {
	once: true,
});

function renderShell(): void {
	if (bridge) {
		void bridge
			.setOverlayVisible(
				ui.menuOpen || ui.downloadsOpen || ui.activityOpen || ui.findOpen
			)
			.catch(() => undefined);
	}
	if (!root) {
		return;
	}
	root.replaceChildren();
	const snapshot = currentState();
	switch (snapshot.surface) {
		case "browser":
			renderBrowser(root, snapshot);
			return;
		case "settings":
			renderSettings(root, snapshot);
			return;
		case "history":
			renderHistory(root, snapshot);
			return;
		case "downloads":
			renderDownloads(root, snapshot);
			return;
		case "passwords":
			renderPasswords(root);
			return;
		default:
			renderPermissions(root, snapshot);
	}
}

setRenderer(renderShell);

if (bridge) {
	bridge
		.getState()
		.then(setState)
		.catch(() => render());
	bridge.onState(setState);
	bridge.onFind((result) => {
		ui.findResult = result;
		render();
	});
} else {
	render();
}
