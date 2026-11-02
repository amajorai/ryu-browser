import { randomUUID } from "node:crypto";
import { type BaseWindow, type Session, WebContentsView } from "electron";
import type { z } from "zod";
import {
	type BrowserActivityStore,
	BrowserCaptureMonitor,
	type BrowserTabActivityKind,
} from "./activity.ts";
import {
	BROWSER_CHROME_HEIGHT,
	type BrowserTabState,
} from "./browser-state.ts";
import { createBrowserActivityInitScript } from "./capture-monitor-script.ts";
import type { BrowserCaptureProtocolValue } from "./capture-records.ts";
import type { BrowserCDPParameters } from "./cdp-records.ts";
import { safeNavigationUrlResolved } from "./control.ts";
import { CDP_PROTOCOL_VERSION, type LiveTab } from "./electron-tab-support.ts";
import { RefError, type TabInfo } from "./tab-manager.ts";
import { installWebAuthnRelay } from "./webauthn-relay/install.ts";
import { WEBMCP_INIT_SCRIPT } from "./webmcp.ts";

/**
 * The visible or Bot tab lane: one Electron window of `WebContentsView` tabs,
 * their lifecycle, activity reporting, and the in-process CDP session every
 * control call goes through. `ElectronTabManager` layers page, inspection,
 * input and credential control on top (one file per layer).
 */
export class ElectronTabBase {
	protected readonly tabs: LiveTab[] = [];
	protected active: string | null = null;
	protected browserVisible = true;
	protected deviceToolbar = false;

	constructor(
		protected readonly browserSession: Session,
		protected readonly win: BaseWindow,
		protected readonly onChange: () => void,
		protected readonly onNavigate: (tab: TabInfo) => void,
		protected readonly onFindResult: (result: {
			activeMatchOrdinal: number;
			matches: number;
		}) => void,
		protected readonly activities?: BrowserActivityStore,
		protected readonly activityOwner = "visible"
	) {
		win.on("resize", () => this.layout());
	}

	/**
	 * Install WebMCP before the first navigation commits. Electron 33's Chromium
	 * does not expose the current document model-context API, so the page-start
	 * bridge provides it while preserving the native API when a newer Electron
	 * build supplies one. The debugger is in-process and already powers the
	 * browser control surface; this does not enable the public CDP port.
	 */
	protected async prepareWebMCP(tab: LiveTab): Promise<void> {
		const contents = tab.view.webContents;
		const debuggerSession = contents.debugger;
		if (!debuggerSession.isAttached()) {
			debuggerSession.attach(CDP_PROTOCOL_VERSION);
		}
		const capability = randomUUID();
		const monitor = new BrowserCaptureMonitor(capability, (kind, active) =>
			this.setTabActivity(tab, kind, active)
		);
		const activityMessageListener = (
			_event: Electron.Event,
			method: string,
			params: BrowserCaptureProtocolValue
		): void => {
			monitor.handleMessage(method, params);
		};
		debuggerSession.on("message", activityMessageListener);
		tab.activityMessageListener = activityMessageListener;
		await debuggerSession.sendCommand("Runtime.enable");
		await debuggerSession.sendCommand("Runtime.addBinding", {
			name: "__ryuBrowserActivity",
		});
		await debuggerSession.sendCommand("Page.enable");
		await debuggerSession.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
			source: createBrowserActivityInitScript(capability),
		});
		await debuggerSession.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
			source: WEBMCP_INIT_SCRIPT,
		});
		await installWebAuthnRelay(contents, this.activityOwner);
	}

	protected layout(): void {
		const [width, height] = this.win.getContentSize();
		for (const t of this.tabs) {
			const visible = this.browserVisible && t.id === this.active;
			t.view.setBounds(
				visible
					? {
							x: 0,
							y: BROWSER_CHROME_HEIGHT,
							width,
							height: Math.max(0, height - BROWSER_CHROME_HEIGHT),
						}
					: { x: 0, y: 0, width: 0, height: 0 }
			);
		}
	}

	protected info(t: LiveTab): TabInfo {
		return {
			id: t.id,
			url: t.view.webContents.getURL(),
			title: t.view.webContents.getTitle(),
		};
	}

	protected find(id: string): LiveTab | undefined {
		return this.tabs.find((t) => t.id === id);
	}

	protected activeTab(): LiveTab | null {
		return this.active ? (this.find(this.active) ?? null) : null;
	}

	protected tabActivityInput(tab: LiveTab, kind: BrowserTabActivityKind) {
		const info = this.info(tab);
		return {
			kind,
			selectable: this.activityOwner === "visible",
			tabId: tab.id,
			tabTitle: info.title || "New tab",
			tabUrl: info.url,
		};
	}

	protected setTabActivity(
		tab: LiveTab,
		kind: BrowserTabActivityKind,
		active: boolean
	): void {
		this.activities?.setTabActivity(this.tabActivityInput(tab, kind), active);
		this.onChange();
	}

	protected updateActivityTab(tab: LiveTab): TabInfo {
		const info = this.info(tab);
		this.activities?.updateTab(tab.id, {
			title: info.title || "New tab",
			url: info.url,
		});
		return info;
	}

	protected recordComputerUse(tab: LiveTab): void {
		this.activities?.startComputerUse({
			agentId: this.activityOwner,
			agentLabel: this.activityOwner === "visible" ? "Ryu" : "Ryu agent",
			selectable: false,
			tabId: tab.id,
			tabTitle: this.info(tab).title || "New tab",
		});
	}

	protected async mediaStillPlaying(tab: LiveTab): Promise<boolean> {
		if (tab.view.webContents.isDestroyed()) {
			return false;
		}
		try {
			const playing: unknown = await tab.view.webContents.executeJavaScript(
				"Array.from(document.querySelectorAll('audio,video')).some((element) => !element.paused && !element.ended && element.readyState > 2)",
				true
			);
			return playing === true;
		} catch {
			return false;
		}
	}

	list(): TabInfo[] {
		return this.tabs.map((t) => this.info(t));
	}

	state(): BrowserTabState[] {
		return this.tabs.map((tab) => ({
			...this.info(tab),
			canGoBack: tab.view.webContents.canGoBack(),
			canGoForward: tab.view.webContents.canGoForward(),
			loading: tab.loading,
			zoomPercent: Math.round(tab.view.webContents.getZoomFactor() * 100),
		}));
	}

	activeId(): string | null {
		return this.active;
	}

	isDeviceToolbarEnabled(): boolean {
		return this.deviceToolbar;
	}

	setBrowserVisible(visible: boolean): void {
		this.browserVisible = visible;
		this.layout();
	}

	select(id: string): boolean {
		if (!this.find(id)) {
			return false;
		}
		this.active = id;
		this.layout();
		this.onChange();
		return true;
	}

	open(url: string): TabInfo {
		const view = new WebContentsView({
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				session: this.browserSession,
			},
		});
		const tab: LiveTab = {
			annotations: [],
			id: randomUUID(),
			loading: true,
			captureReady: Promise.resolve(),
			refs: new Map(),
			snapshotId: null,
			view,
		};
		this.tabs.push(tab);
		this.win.contentView.addChildView(view);
		this.active = tab.id;
		view.webContents.setWindowOpenHandler((details) => {
			void safeNavigationUrlResolved(details.url)
				.then((url) => this.open(url))
				.catch(() => undefined);
			return { action: "deny" };
		});
		tab.captureReady = view.webContents
			.loadURL("about:blank")
			.then(() => this.prepareWebMCP(tab));
		void tab.captureReady
			.then(() => view.webContents.loadURL(url))
			.catch(() => undefined);
		view.webContents.on("page-title-updated", () => {
			this.onNavigate(this.updateActivityTab(tab));
			this.onChange();
		});
		view.webContents.on("did-start-loading", () => {
			tab.loading = true;
			this.onChange();
		});
		view.webContents.on("did-stop-loading", () => {
			tab.loading = false;
			this.onNavigate(this.updateActivityTab(tab));
			this.onChange();
		});
		view.webContents.on("media-started-playing", () => {
			this.setTabActivity(tab, "audio", true);
		});
		view.webContents.on("media-paused", () => {
			void this.mediaStillPlaying(tab).then((playing) => {
				if (!playing) {
					this.setTabActivity(tab, "audio", false);
				}
			});
		});
		// A committed main-frame navigation destroys every node the last snapshot
		// referenced. Dropping the map turns a stale ref into an explicit
		// "unknown element ref" (400, re-run snapshot) instead of a `backendNodeId`
		// that either errors deep in CDP or, worse, resolves to an unrelated node in
		// the new document.
		view.webContents.on("did-navigate", () => {
			tab.refs.clear();
			tab.snapshotId = null;
			tab.annotations = [];
			this.activities?.clearTab(tab.id);
			this.onNavigate(this.updateActivityTab(tab));
			this.onChange();
		});
		view.webContents.on("did-navigate-in-page", () => {
			this.onNavigate(this.updateActivityTab(tab));
			this.onChange();
		});
		view.webContents.on("found-in-page", (_event, result) => {
			this.onFindResult({
				activeMatchOrdinal: result.activeMatchOrdinal,
				matches: result.matches,
			});
		});
		this.layout();
		this.onChange();
		return this.info(tab);
	}

	close(id: string): boolean {
		const idx = this.tabs.findIndex((t) => t.id === id);
		if (idx < 0) {
			return false;
		}
		const [tab] = this.tabs.splice(idx, 1);
		this.win.contentView.removeChildView(tab.view);
		this.activities?.clearTab(tab.id);
		// Detach before the contents go away so the CDP session is released even if
		// the tab is reopened at the same address later.
		try {
			if (tab.activityMessageListener) {
				tab.view.webContents.debugger.removeListener(
					"message",
					tab.activityMessageListener
				);
			}
			if (tab.view.webContents.debugger.isAttached()) {
				tab.view.webContents.debugger.detach();
			}
		} catch {
			// Already gone; closing is still the outcome the caller asked for.
		}
		tab.view.webContents.close();
		if (this.active === id) {
			this.active = this.tabs.at(-1)?.id ?? null;
		}
		this.layout();
		this.onChange();
		return true;
	}

	navigate(id: string, url: string): TabInfo | null {
		const tab = this.find(id);
		if (!tab) {
			return null;
		}
		this.active = id;
		tab.loading = true;
		// Same-document and failed navigation retain live capture tracks. Only
		// committed navigation/context teardown may clear their activity state.
		void tab.captureReady
			.then(() => tab.view.webContents.loadURL(url))
			.catch(() => undefined);
		this.layout();
		this.onChange();
		return this.info(tab);
	}

	protected focusForControl(id: string): LiveTab | null {
		const tab = this.find(id);
		if (!tab) {
			return null;
		}
		if (this.active !== id) {
			this.active = id;
			this.layout();
		}
		this.recordComputerUse(tab);
		this.onChange();
		return tab;
	}

	/**
	 * Send one CDP command over the tab's in-process debugger session, attaching on
	 * first use. `attach` throws when a session already exists (e.g. DevTools is
	 * open on those contents), so it is guarded by `isAttached` and its failure is
	 * turned into a legible error rather than an unhandled main-process rejection.
	 */
	protected async cdp<T>(
		tab: LiveTab,
		method: string,
		schema: z.ZodType<T>,
		params?: BrowserCDPParameters
	): Promise<T> {
		const dbg = tab.view.webContents.debugger;
		if (!dbg.isAttached()) {
			try {
				dbg.attach(CDP_PROTOCOL_VERSION);
			} catch (e) {
				throw new Error(
					`could not attach the browser debugger: ${e instanceof Error ? e.message : String(e)}`
				);
			}
		}
		return schema.parse(await dbg.sendCommand(method, params));
	}

	/** Resolve a snapshot ref to its `backendDOMNodeId`, or fail with a fixable error. */
	protected static resolveRef(tab: LiveTab, ref: string): number {
		const backendNodeId = tab.refs.get(ref);
		if (backendNodeId === undefined) {
			throw new RefError(
				tab.refs.size === 0
					? `unknown element ref '${ref}': this tab has no current snapshot (it may have navigated) — call snapshot first`
					: `unknown element ref '${ref}': it is not in this tab's current snapshot — call snapshot again`
			);
		}
		return backendNodeId;
	}

	title(id: string): string | null {
		const tab = this.find(id);
		return tab ? tab.view.webContents.getTitle() : null;
	}
}
