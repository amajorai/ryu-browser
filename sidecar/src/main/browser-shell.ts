import { join } from "node:path";
import {
	BaseWindow,
	session,
	type WebContents,
	WebContentsView,
} from "electron";
import { z } from "zod";
import { SHELL_LOCALE_ARGUMENT } from "../i18n/locale-argument.ts";
import { setShellLocale, shellLocale } from "../i18n/shell-i18n.ts";
import type { BrowserActivityStore } from "./activity.ts";
import type { BrowserSessionRouter } from "./bot-session-router.ts";
import type { BrowserExtensionManager } from "./browser-extensions.ts";
import {
	BROWSER_CHROME_HEIGHT,
	type BrowserSettings,
	type BrowserState,
	type BrowserSurface,
} from "./browser-state.ts";
import type { BrowserStateStore } from "./browser-state-store.ts";
import type { ElectronTabManager } from "./electron-tab-manager.ts";
import { persistShellLocale } from "./locale-store.ts";
import { safeNavigationUrlResolved } from "./navigation-safety.ts";
import { codedNavigationError, shellError } from "./shell-error.ts";

export interface BrowserRuntime {
	activities: BrowserActivityStore;
	extensions: BrowserExtensionManager;
	overlayVisible: boolean;
	store: BrowserStateStore;
	strip: WebContents;
	stripView: WebContentsView;
	surface: BrowserSurface;
	tabs: ElectronTabManager;
	themeTokens: Record<string, string>;
	win: BaseWindow;
}

/** Process-wide browser runtime, shared by the shell, IPC, and startup modules. */
export const sidecarState: {
	botSessions: BrowserSessionRouter | null;
	remoteCdpEnabled: boolean;
	runtime: BrowserRuntime | null;
} = { botSessions: null, remoteCdpEnabled: false, runtime: null };

export function layoutShell(): void {
	if (!sidecarState.runtime) {
		return;
	}
	const [width, height] = sidecarState.runtime.win.getContentSize();
	sidecarState.runtime.stripView.setBounds({
		height:
			sidecarState.runtime.surface === "browser" &&
			!sidecarState.runtime.overlayVisible
				? BROWSER_CHROME_HEIGHT
				: height,
		width,
		x: 0,
		y: 0,
	});
}

export interface CreateWindowResult {
	strip: WebContents;
	stripView: WebContentsView;
	win: BaseWindow;
}

export function createWindow(): CreateWindowResult {
	const win = new BaseWindow({
		height: 800,
		show: true,
		title: "Ryu Browser",
		width: 1200,
	});
	const strip = new WebContentsView({
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			// The shell renderer starts in this locale; the preload reads it back.
			additionalArguments: [`${SHELL_LOCALE_ARGUMENT}${shellLocale()}`],
			contextIsolation: true,
			nodeIntegration: false,
			// The trusted shell uses electron-vite's local dev server. Page tabs use
			// the guarded sessions configured before this window is created.
			session: session.fromPartition("ryu-browser-shell"),
		},
	});
	win.contentView.addChildView(strip);
	const [width] = win.getContentSize();
	strip.setBounds({ x: 0, y: 0, width, height: BROWSER_CHROME_HEIGHT });
	win.on("resize", () => {
		if (sidecarState.runtime) {
			layoutShell();
			return;
		}
		const [nextWidth] = win.getContentSize();
		strip.setBounds({
			height: BROWSER_CHROME_HEIGHT,
			width: nextWidth,
			x: 0,
			y: 0,
		});
	});
	// Renderer served by electron-vite (dev) or the built file (prod).
	if (process.env.ELECTRON_RENDERER_URL) {
		strip.webContents
			.loadURL(process.env.ELECTRON_RENDERER_URL)
			.catch(() => undefined);
	} else {
		strip.webContents
			.loadFile(join(import.meta.dirname, "../renderer/index.html"))
			.catch(() => undefined);
	}
	return { strip: strip.webContents, stripView: strip, win };
}

export function setChromeSurface(surface: BrowserSurface): void {
	if (!sidecarState.runtime) {
		return;
	}
	sidecarState.runtime.surface = surface;
	sidecarState.runtime.overlayVisible = false;
	sidecarState.runtime.tabs.setBrowserVisible(surface === "browser");
	layoutShell();
	emitState();
}

export function emitState(): void {
	if (!sidecarState.runtime) {
		return;
	}
	// The active Chromium view is added after the shell view. Re-add the shell as
	// the same child to keep menus, find, and downloads popovers above the page.
	sidecarState.runtime.win.contentView.removeChildView(
		sidecarState.runtime.stripView
	);
	sidecarState.runtime.win.contentView.addChildView(
		sidecarState.runtime.stripView
	);
	sidecarState.runtime.strip.send(
		"ryu-browser:tabs",
		sidecarState.runtime.tabs.list()
	);
	sidecarState.runtime.strip.send(
		"ryu-browser:theme",
		sidecarState.runtime.themeTokens
	);
	sidecarState.runtime.strip.send("ryu-browser:state", getBrowserState());
}

export function setThemeTokens(tokens: Record<string, string>): void {
	if (!sidecarState.runtime) {
		return;
	}
	sidecarState.runtime.themeTokens = { ...tokens };
	// The desktop's theme snapshot carries its UI language; native dialogs
	// follow it (the shell renderer reads the same token).
	setShellLocale(tokens["--ryu-locale"]);
	// Remember it so the next cold start (an agent launch with no desktop panel
	// mounted) opens in the Ryu language instead of the OS one.
	persistShellLocale(tokens["--ryu-locale"]);
	sidecarState.runtime.strip.send(
		"ryu-browser:theme",
		sidecarState.runtime.themeTokens
	);
}

export function getBrowserState(): BrowserState {
	if (!sidecarState.runtime) {
		throw new Error("browser sidecarState.runtime is not ready");
	}
	const active = sidecarState.runtime.tabs
		.state()
		.find((tab) => tab.id === sidecarState.runtime?.tabs.activeId());
	return {
		activities: sidecarState.runtime.activities.snapshot(),
		activeId: sidecarState.runtime.tabs.activeId(),
		activeTitle: active?.title ?? "",
		activeUrl: active?.url ?? "about:blank",
		cdpRestartRequired:
			sidecarState.runtime.store.getSettings().developerCdp !==
			sidecarState.remoteCdpEnabled,
		deviceToolbar: sidecarState.runtime.tabs.isDeviceToolbarEnabled(),
		downloads: sidecarState.runtime.store.getDownloads(),
		extensions: sidecarState.runtime.extensions.list(),
		history: sidecarState.runtime.store.getHistory(),
		settings: sidecarState.runtime.store.getSettings(),
		surface: sidecarState.runtime.surface,
		tabs: sidecarState.runtime.tabs.state(),
	};
}

export async function normalizedNavigationUrl(value: string): Promise<string> {
	const trimmed = value.trim();
	if (trimmed === "") {
		throw shellError("url-required", "Enter a URL");
	}
	const candidate =
		/\s/.test(trimmed) && !/^https?:\/\//i.test(trimmed)
			? `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
			: /^(?:https?:|about:)/i.test(trimmed)
				? trimmed
				: `https://${trimmed}`;
	try {
		return await safeNavigationUrlResolved(candidate);
	} catch (error) {
		throw codedNavigationError(error);
	}
}

export function updateSetting(
	key: string,
	value: BrowserSettings[keyof BrowserSettings]
): void {
	const parsedKey = z.string().safeParse(key);
	if (!(sidecarState.runtime && parsedKey.success)) {
		throw new Error("Invalid browser setting");
	}
	switch (parsedKey.data) {
		case "allowControl":
		case "askWhereToSave":
		case "developerCdp": {
			const parsedBoolean = z.boolean().safeParse(value);
			if (!parsedBoolean.success) {
				throw new Error("Invalid boolean browser setting");
			}
			sidecarState.runtime.store.setSetting(parsedKey.data, parsedBoolean.data);
			return;
		}
		case "annotationScreenshots":
			if (value !== "always" && value !== "ask" && value !== "never") {
				throw new Error("Invalid annotation screenshot policy");
			}
			sidecarState.runtime.store.setSetting(parsedKey.data, value);
			return;
		case "approval":
		case "historyAccess":
			if (value !== "always-allow" && value !== "always-ask") {
				throw new Error("Invalid permission policy");
			}
			sidecarState.runtime.store.setSetting(parsedKey.data, value);
			return;
		case "webLinkDestination":
		case "localLinkDestination":
			if (value !== "default" && value !== "ryu") {
				throw new Error("Invalid link destination");
			}
			sidecarState.runtime.store.setSetting(parsedKey.data, value);
			return;
		default:
			throw new Error(
				"This browser setting is managed by its dedicated control"
			);
	}
}
