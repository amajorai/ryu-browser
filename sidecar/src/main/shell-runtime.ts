// The visible browser window: its shell view, runtime state, and the state
// snapshot the shell renderer draws.

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
import type { BrowserExtensionManager } from "./browser-extensions.ts";
import {
	BROWSER_CHROME_HEIGHT,
	type BrowserSettings,
	type BrowserState,
	type BrowserSurface,
} from "./browser-state.ts";
import type { BrowserStateStore } from "./browser-state-store.ts";
import { safeNavigationUrlResolved } from "./control.ts";
import type { ElectronTabManager } from "./electron-tab-manager.ts";
import { remoteCdpEnabled } from "./startup.ts";

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

export let runtime: BrowserRuntime | null = null;

/** Install the visible browser runtime once the window and stores exist. */
export function setRuntime(next: BrowserRuntime): void {
	runtime = next;
}

export function layoutShell(): void {
	if (!runtime) {
		return;
	}
	const [width, height] = runtime.win.getContentSize();
	runtime.stripView.setBounds({
		height:
			runtime.surface === "browser" && !runtime.overlayVisible
				? BROWSER_CHROME_HEIGHT
				: height,
		width,
		x: 0,
		y: 0,
	});
}

interface CreateWindowResult {
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
		if (runtime) {
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
	if (!runtime) {
		return;
	}
	runtime.surface = surface;
	runtime.overlayVisible = false;
	runtime.tabs.setBrowserVisible(surface === "browser");
	layoutShell();
	emitState();
}

export function emitState(): void {
	if (!runtime) {
		return;
	}
	// The active Chromium view is added after the shell view. Re-add the shell as
	// the same child to keep menus, find, and downloads popovers above the page.
	runtime.win.contentView.removeChildView(runtime.stripView);
	runtime.win.contentView.addChildView(runtime.stripView);
	runtime.strip.send("ryu-browser:tabs", runtime.tabs.list());
	runtime.strip.send("ryu-browser:theme", runtime.themeTokens);
	runtime.strip.send("ryu-browser:state", getBrowserState());
}

export function setThemeTokens(tokens: Record<string, string>): void {
	if (!runtime) {
		return;
	}
	runtime.themeTokens = { ...tokens };
	// The desktop's theme snapshot carries its UI language; native dialogs
	// follow it (the shell renderer reads the same token).
	setShellLocale(tokens["--ryu-locale"]);
	runtime.strip.send("ryu-browser:theme", runtime.themeTokens);
}

export function getBrowserState(): BrowserState {
	if (!runtime) {
		throw new Error("browser runtime is not ready");
	}
	const active = runtime.tabs
		.state()
		.find((tab) => tab.id === runtime?.tabs.activeId());
	return {
		activities: runtime.activities.snapshot(),
		activeId: runtime.tabs.activeId(),
		activeTitle: active?.title ?? "",
		activeUrl: active?.url ?? "about:blank",
		cdpRestartRequired:
			runtime.store.getSettings().developerCdp !== remoteCdpEnabled,
		deviceToolbar: runtime.tabs.isDeviceToolbarEnabled(),
		downloads: runtime.store.getDownloads(),
		extensions: runtime.extensions.list(),
		history: runtime.store.getHistory(),
		settings: runtime.store.getSettings(),
		surface: runtime.surface,
		tabs: runtime.tabs.state(),
	};
}

export async function normalizedNavigationUrl(value: string): Promise<string> {
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new Error("Enter a URL");
	}
	if (/\s/.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
		return safeNavigationUrlResolved(
			`https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
		);
	}
	return safeNavigationUrlResolved(
		/^(?:https?:|about:)/i.test(trimmed) ? trimmed : `https://${trimmed}`
	);
}

export function updateSetting(
	key: string,
	value: BrowserSettings[keyof BrowserSettings]
): void {
	const parsedKey = z.string().safeParse(key);
	if (!(runtime && parsedKey.success)) {
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
			runtime.store.setSetting(parsedKey.data, parsedBoolean.data);
			return;
		}
		case "annotationScreenshots":
			if (value !== "always" && value !== "ask" && value !== "never") {
				throw new Error("Invalid annotation screenshot policy");
			}
			runtime.store.setSetting(parsedKey.data, value);
			return;
		case "approval":
		case "historyAccess":
			if (value !== "always-allow" && value !== "always-ask") {
				throw new Error("Invalid permission policy");
			}
			runtime.store.setSetting(parsedKey.data, value);
			return;
		case "webLinkDestination":
		case "localLinkDestination":
			if (value !== "default" && value !== "ryu") {
				throw new Error("Invalid link destination");
			}
			runtime.store.setSetting(parsedKey.data, value);
			return;
		default:
			throw new Error(
				"This browser setting is managed by its dedicated control"
			);
	}
}
