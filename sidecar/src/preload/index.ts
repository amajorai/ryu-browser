import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import {
	browserFindResultSchema,
	browserStateSchema,
	browserTabInfoSchema,
	browserThemeSchema,
} from "../main/browser-records.ts";
import type {
	BrowserPermission,
	BrowserSettings,
	BrowserState,
	BrowserSurface,
	SitePermission,
} from "../main/browser-state.ts";
import {
	browserCookieImportResultSchema,
	browserScreenshotResultSchema,
} from "./ipc-records.ts";

interface TabInfo {
	id: string;
	title: string;
	url: string;
}

interface FindResult {
	activeMatchOrdinal: number;
	matches: number;
}

export interface RyuBrowserBridge {
	addSitePermission(input: SitePermission): Promise<BrowserState>;
	back(): Promise<BrowserState>;
	chooseDownloadDirectory(): Promise<BrowserState | null>;
	chooseExtensionDirectory(): Promise<BrowserState | null>;
	clearBrowsingData(): Promise<BrowserState>;
	clearDownloads(): Promise<BrowserState>;
	clearHistory(): Promise<BrowserState>;
	close(id: string): Promise<BrowserState>;
	find(query: string): Promise<void>;
	forward(): Promise<BrowserState>;
	getState(): Promise<BrowserState>;
	getTheme(): Promise<Record<string, string>>;
	importCookies(): Promise<{ imported: number; message?: string }>;
	list(): Promise<TabInfo[]>;
	navigate(url: string): Promise<BrowserState>;
	onFind(cb: (result: FindResult) => void): () => void;
	onState(cb: (state: BrowserState) => void): () => void;
	onTabs(cb: (tabs: TabInfo[]) => void): () => void;
	onTheme(cb: (tokens: Record<string, string>) => void): () => void;
	open(url?: string): Promise<BrowserState>;
	openDevTools(): Promise<void>;
	openDownloadsFolder(): Promise<void>;
	reload(): Promise<BrowserState>;
	removeExtension(id: string): Promise<BrowserState>;
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

type BrowserIPCArgument =
	| string
	| boolean
	| SitePermission
	| BrowserSettings[keyof BrowserSettings]
	| undefined;
function invoke<T>(
	schema: z.ZodType<T>,
	channel: string,
	...args: BrowserIPCArgument[]
): Promise<T> {
	return ipcRenderer
		.invoke(channel, ...args)
		.then((value) => schema.parse(value));
}

const bridge: RyuBrowserBridge = {
	addSitePermission: (input) =>
		invoke(browserStateSchema, "ryu-browser:add-site-permission", input),
	back: () => invoke(browserStateSchema, "ryu-browser:back"),
	chooseDownloadDirectory: () =>
		invoke(
			browserStateSchema.nullable(),
			"ryu-browser:choose-download-directory"
		),
	clearBrowsingData: () =>
		invoke(browserStateSchema, "ryu-browser:clear-browsing-data"),
	clearDownloads: () =>
		invoke(browserStateSchema, "ryu-browser:clear-downloads"),
	clearHistory: () => invoke(browserStateSchema, "ryu-browser:clear-history"),
	close: (id) => invoke(browserStateSchema, "ryu-browser:close", id),
	chooseExtensionDirectory: () =>
		invoke(
			browserStateSchema.nullable(),
			"ryu-browser:choose-extension-directory"
		),
	find: (query) => invoke(z.void(), "ryu-browser:find", query),
	forward: () => invoke(browserStateSchema, "ryu-browser:forward"),
	getState: () => invoke(browserStateSchema, "ryu-browser:get-state"),
	getTheme: () => invoke(browserThemeSchema, "ryu-browser:get-theme"),
	importCookies: () =>
		invoke(browserCookieImportResultSchema, "ryu-browser:import-cookies"),
	list: () => invoke(z.array(browserTabInfoSchema), "ryu-browser:list"),
	navigate: (url) => invoke(browserStateSchema, "ryu-browser:navigate", url),
	onFind: (cb) => {
		const listener = (_event: Electron.IpcRendererEvent, result: FindResult) =>
			cb(browserFindResultSchema.parse(result));
		ipcRenderer.on("ryu-browser:find-result", listener);
		return () =>
			ipcRenderer.removeListener("ryu-browser:find-result", listener);
	},
	onState: (cb) => {
		const listener = (_event: Electron.IpcRendererEvent, state: BrowserState) =>
			cb(browserStateSchema.parse(state));
		ipcRenderer.on("ryu-browser:state", listener);
		return () => ipcRenderer.removeListener("ryu-browser:state", listener);
	},
	onTheme: (cb) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			tokens: Record<string, string>
		) => cb(browserThemeSchema.parse(tokens));
		ipcRenderer.on("ryu-browser:theme", listener);
		return () => ipcRenderer.removeListener("ryu-browser:theme", listener);
	},
	onTabs: (cb) => {
		const listener = (_event: Electron.IpcRendererEvent, tabs: TabInfo[]) =>
			cb(z.array(browserTabInfoSchema).parse(tabs));
		ipcRenderer.on("ryu-browser:tabs", listener);
		return () => ipcRenderer.removeListener("ryu-browser:tabs", listener);
	},
	open: (url) => invoke(browserStateSchema, "ryu-browser:open", url),
	openDownloadsFolder: () =>
		invoke(z.void(), "ryu-browser:open-downloads-folder"),
	openDevTools: () => invoke(z.void(), "ryu-browser:open-devtools"),
	removeSitePermission: (origin, permission) =>
		invoke(
			browserStateSchema,
			"ryu-browser:remove-site-permission",
			origin,
			permission
		),
	removeExtension: (id) =>
		invoke(browserStateSchema, "ryu-browser:remove-extension", id),
	reload: () => invoke(browserStateSchema, "ryu-browser:reload"),
	select: (id) => invoke(browserStateSchema, "ryu-browser:select", id),
	setCdpEnabled: (enabled) =>
		invoke(browserStateSchema, "ryu-browser:set-cdp-enabled", enabled),
	setOverlayVisible: (visible) =>
		invoke(z.void(), "ryu-browser:set-overlay-visible", visible),
	setSetting: (key, value) =>
		invoke(browserStateSchema, "ryu-browser:set-setting", key, value),
	setSurface: (surface) =>
		invoke(browserStateSchema, "ryu-browser:set-surface", surface),
	showScreenshot: () =>
		invoke(browserScreenshotResultSchema, "ryu-browser:show-screenshot"),
	stopFind: () => invoke(z.void(), "ryu-browser:stop-find"),
	toggleDeviceToolbar: () =>
		invoke(browserStateSchema, "ryu-browser:toggle-device-toolbar"),
	zoom: (action) => invoke(browserStateSchema, "ryu-browser:zoom", action),
};

contextBridge.exposeInMainWorld("ryuBrowser", bridge);
