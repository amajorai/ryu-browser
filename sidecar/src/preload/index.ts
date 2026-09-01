import { contextBridge, ipcRenderer } from "electron";
import type {
	BrowserPermission,
	BrowserSettings,
	BrowserState,
	BrowserSurface,
	SitePermission,
} from "../main/browser-state.ts";

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
	clearBrowsingData(): Promise<BrowserState>;
	clearDownloads(): Promise<BrowserState>;
	clearHistory(): Promise<BrowserState>;
	close(id: string): Promise<BrowserState>;
	find(query: string): Promise<void>;
	forward(): Promise<BrowserState>;
	getState(): Promise<BrowserState>;
	importCookies(): Promise<{ imported: number; message?: string }>;
	list(): Promise<TabInfo[]>;
	navigate(url: string): Promise<BrowserState>;
	onFind(cb: (result: FindResult) => void): () => void;
	onState(cb: (state: BrowserState) => void): () => void;
	onTabs(cb: (tabs: TabInfo[]) => void): () => void;
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

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const bridge: RyuBrowserBridge = {
	addSitePermission: (input) =>
		invoke("ryu-browser:add-site-permission", input),
	back: () => invoke("ryu-browser:back"),
	chooseDownloadDirectory: () =>
		invoke("ryu-browser:choose-download-directory"),
	clearBrowsingData: () => invoke("ryu-browser:clear-browsing-data"),
	clearDownloads: () => invoke("ryu-browser:clear-downloads"),
	clearHistory: () => invoke("ryu-browser:clear-history"),
	close: (id) => invoke("ryu-browser:close", id),
	find: (query) => invoke("ryu-browser:find", query),
	forward: () => invoke("ryu-browser:forward"),
	getState: () => invoke("ryu-browser:get-state"),
	importCookies: () => invoke("ryu-browser:import-cookies"),
	list: () => invoke("ryu-browser:list"),
	navigate: (url) => invoke("ryu-browser:navigate", url),
	onFind: (cb) => {
		const listener = (_event: Electron.IpcRendererEvent, result: FindResult) =>
			cb(result);
		ipcRenderer.on("ryu-browser:find-result", listener);
		return () =>
			ipcRenderer.removeListener("ryu-browser:find-result", listener);
	},
	onState: (cb) => {
		const listener = (_event: Electron.IpcRendererEvent, state: BrowserState) =>
			cb(state);
		ipcRenderer.on("ryu-browser:state", listener);
		return () => ipcRenderer.removeListener("ryu-browser:state", listener);
	},
	onTabs: (cb) => {
		const listener = (_event: Electron.IpcRendererEvent, tabs: TabInfo[]) =>
			cb(tabs);
		ipcRenderer.on("ryu-browser:tabs", listener);
		return () => ipcRenderer.removeListener("ryu-browser:tabs", listener);
	},
	open: (url) => invoke("ryu-browser:open", url),
	openDownloadsFolder: () => invoke("ryu-browser:open-downloads-folder"),
	openDevTools: () => invoke("ryu-browser:open-devtools"),
	removeSitePermission: (origin, permission) =>
		invoke("ryu-browser:remove-site-permission", origin, permission),
	reload: () => invoke("ryu-browser:reload"),
	select: (id) => invoke("ryu-browser:select", id),
	setCdpEnabled: (enabled) => invoke("ryu-browser:set-cdp-enabled", enabled),
	setOverlayVisible: (visible) =>
		invoke("ryu-browser:set-overlay-visible", visible),
	setSetting: (key, value) => invoke("ryu-browser:set-setting", key, value),
	setSurface: (surface) => invoke("ryu-browser:set-surface", surface),
	showScreenshot: () => invoke("ryu-browser:show-screenshot"),
	stopFind: () => invoke("ryu-browser:stop-find"),
	toggleDeviceToolbar: () => invoke("ryu-browser:toggle-device-toolbar"),
	zoom: (action) => invoke("ryu-browser:zoom", action),
};

contextBridge.exposeInMainWorld("ryuBrowser", bridge);
