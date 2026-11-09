import type {
	BrowserPermission,
	BrowserSettings,
	BrowserState,
	BrowserSurface,
	SitePermission,
} from "../main/browser-state.ts";

/** The `window.ryuBrowser` bridge the preload exposes to the shell renderer. */
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
	/** The shell locale the main process started this window in. */
	readonly locale?: string | null;
	navigate(url: string): Promise<BrowserState>;
	onFind(
		cb: (result: { activeMatchOrdinal: number; matches: number }) => void
	): () => void;
	onState(cb: (state: BrowserState) => void): () => void;
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

declare global {
	interface Window {
		ryuBrowser?: RyuBrowserBridge;
	}
}

/** The preload bridge, absent in a plain browser preview. */
export const bridge: RyuBrowserBridge | undefined =
	globalThis.window?.ryuBrowser;
