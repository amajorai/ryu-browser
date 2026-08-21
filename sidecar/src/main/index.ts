// Ryu Browser sidecar — Electron main process.
//
// A real-Chromium browser Core spawns as a `local` manifest sidecar. Each tab is a
// modern `WebContentsView` (Electron ≥30) attached under a native browser shell.
// The loopback control server (`control.ts`) and the shell renderer share the
// same tab manager, so user actions and agent actions stay in one session.
//
// CDP, two independent things — do not conflate them:
//  * Chromium's remote-debugging PORT (an open TCP debugging endpoint) is enabled
//    only for the explicit Developer mode setting (or the standalone
//    `RYU_BROWSER_CDP=1` override), matching the ghost-core CDP precedent's
//    opt-in posture.
//  * `webContents.debugger` is an IN-PROCESS CDP session Electron exposes with no
//    port and no external surface. That is what snapshot/click/type/scroll use, so
//    they work with the debugging port off.

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	app,
	BaseWindow,
	dialog,
	ipcMain,
	session,
	shell,
	type WebContents,
	WebContentsView,
} from "electron";
import {
	type AXNodeLike,
	buildSnapshot,
	quadCenter,
	scrollDelta,
} from "./ax-snapshot.ts";
import {
	BROWSER_CHROME_HEIGHT,
	type BrowserDownloadEntry,
	type BrowserHistoryEntry,
	type BrowserPermission,
	type BrowserSettings,
	type BrowserState,
	type BrowserSurface,
	type BrowserTabState,
	cookieImportUrl,
	isBrowserPermission,
	normalizeBrowserSettings,
	type SitePermission,
	safeDownloadFilename,
} from "./browser-state.ts";
import {
	resolveControlPort,
	resolveControlToken,
	safeNavigationUrl,
	startControlServer,
} from "./control.ts";
import {
	type ActionResult,
	type BrowserAnnotation,
	type BrowserAnnotationInput,
	type BrowserContextRequest,
	type BrowserContextResult,
	type BrowserCoordinateAction,
	type BrowserElementContext,
	type BrowserMouseButton,
	type BrowserRect,
	type BrowserStyleAdjust,
	RefError,
	type ScrollDirection,
	type SnapshotResult,
	type TabInfo,
	type TabManager,
} from "./tab-manager.ts";

function resolveRemoteCdpEnabled(): boolean {
	const override = process.env.RYU_BROWSER_CDP?.trim();
	if (override) {
		return override === "1";
	}
	try {
		const persisted = JSON.parse(
			readFileSync(join(app.getPath("userData"), "browser-state.json"), "utf8")
		) as { settings?: { developerCdp?: unknown } };
		return persisted.settings?.developerCdp === true;
	} catch {
		return false;
	}
}

// Opt-in CDP. Must be set before `app` is ready. The persisted setting is read
// before startup so the Developer mode toggle is effective after a restart.
const remoteCdpEnabled = resolveRemoteCdpEnabled();
if (remoteCdpEnabled) {
	app.commandLine.appendSwitch("remote-debugging-port", "9222");
	app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

/** CDP version to attach `webContents.debugger` with. */
const CDP_PROTOCOL_VERSION = "1.3";
/** Fallback viewport when `Page.getLayoutMetrics` reports nothing usable. */
const FALLBACK_VIEWPORT = { height: 800, width: 1200 };
const MAX_CONTEXT_SELECTIONS = 8;
const MAX_ANNOTATION_COMMENT_LENGTH = 4000;
const DOWNLOAD_PERSIST_DELAY_MS = 250;
const INSPECTION_STYLE_PROPERTIES = [
	"background-color",
	"border-radius",
	"color",
	"display",
	"font-family",
	"font-size",
	"font-weight",
	"letter-spacing",
	"line-height",
	"margin",
	"padding",
	"position",
	"text-align",
	"visibility",
	"width",
	"height",
] as const;
/** `Enter`, for `submit: true`. */
const ENTER_KEY = {
	code: "Enter",
	key: "Enter",
	nativeVirtualKeyCode: 13,
	windowsVirtualKeyCode: 13,
};
/** `Delete`, for `replace: true` with empty text (i.e. "clear this field"). */
const DELETE_KEY = {
	code: "Delete",
	key: "Delete",
	nativeVirtualKeyCode: 46,
	windowsVirtualKeyCode: 46,
};

interface LiveTab {
	/** Visual notes survive browser-context reads and are cleared on navigation. */
	annotations: BrowserAnnotation[];
	id: string;
	loading: boolean;
	/** Element ref (`"@e1"`) → CDP `backendDOMNodeId`, minted by the last snapshot. */
	refs: Map<string, number>;
	/** Id of the last snapshot; cleared refs mean the caller must snapshot again. */
	snapshotId: string | null;
	view: WebContentsView;
}

interface ViewportMetrics {
	height: number;
	scroll_x: number;
	scroll_y: number;
	width: number;
}

interface RuntimeValue<T> {
	result?: { value?: T };
}

interface InspectedElement extends BrowserElementContext {
	backend_node_id?: number;
}

interface PersistedBrowserState {
	downloads?: BrowserDownloadEntry[];
	history?: BrowserHistoryEntry[];
	settings?: Partial<BrowserSettings>;
}

/** Small, local-only store for browser preferences and non-sensitive metadata. */
class BrowserStateStore {
	private readonly filePath: string;
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private settings: BrowserSettings;
	private history: BrowserHistoryEntry[];
	private downloads: BrowserDownloadEntry[];

	constructor(userDataPath: string, downloadDirectory: string) {
		mkdirSync(userDataPath, { recursive: true });
		this.filePath = join(userDataPath, "browser-state.json");
		let persisted: PersistedBrowserState = {};
		if (existsSync(this.filePath)) {
			try {
				const raw = readFileSync(this.filePath, "utf8");
				const parsed: unknown = JSON.parse(raw);
				if (typeof parsed === "object" && parsed !== null) {
					persisted = parsed as PersistedBrowserState;
				}
			} catch {
				// A damaged local preference file should restore defaults, never stop the
				// browser from opening.
			}
		}
		this.settings = normalizeBrowserSettings(
			persisted.settings,
			downloadDirectory
		);
		this.history = Array.isArray(persisted.history)
			? persisted.history.filter(isHistoryEntry).slice(0, 200)
			: [];
		this.downloads = Array.isArray(persisted.downloads)
			? persisted.downloads.filter(isDownloadEntry).slice(0, 100)
			: [];
	}

	getSettings(): BrowserSettings {
		return {
			...this.settings,
			sitePermissions: [...this.settings.sitePermissions],
		};
	}

	getHistory(): BrowserHistoryEntry[] {
		return [...this.history];
	}

	getDownloads(): BrowserDownloadEntry[] {
		return [...this.downloads];
	}

	setSetting<K extends keyof BrowserSettings>(
		key: K,
		value: BrowserSettings[K]
	): void {
		this.settings = { ...this.settings, [key]: value };
		this.persist();
	}

	setSitePermission(input: {
		origin: string;
		permission: BrowserPermission;
		decision: "allow" | "deny";
	}): void {
		const remaining = this.settings.sitePermissions.filter(
			(item) =>
				!(item.origin === input.origin && item.permission === input.permission)
		);
		this.settings = {
			...this.settings,
			sitePermissions: [...remaining, input],
		};
		this.persist();
	}

	removeSitePermission(origin: string, permission: BrowserPermission): void {
		this.settings = {
			...this.settings,
			sitePermissions: this.settings.sitePermissions.filter(
				(item) => !(item.origin === origin && item.permission === permission)
			),
		};
		this.persist();
	}

	permissionFor(
		origin: string,
		permission: BrowserPermission
	): "allow" | "deny" | null {
		return (
			this.settings.sitePermissions.find(
				(item) => item.origin === origin && item.permission === permission
			)?.decision ?? null
		);
	}

	addHistory(url: string, title: string): void {
		if (!url || url === "about:blank") {
			return;
		}
		const now = Date.now();
		const withoutDuplicate = this.history.filter((entry) => entry.url !== url);
		this.history = [
			{ id: randomUUID(), title, url, visitedAt: now },
			...withoutDuplicate,
		].slice(0, 200);
		this.persist();
	}

	clearHistory(): void {
		this.history = [];
		this.persist();
	}

	clearDownloads(): void {
		this.downloads = [];
		this.persist();
	}

	upsertDownload(
		entry: BrowserDownloadEntry,
		options: { defer?: boolean } = {}
	): void {
		const remaining = this.downloads.filter((item) => item.id !== entry.id);
		this.downloads = [entry, ...remaining].slice(0, 100);
		if (options.defer) {
			this.schedulePersist();
		} else {
			this.persist();
		}
	}

	private persist(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		this.persistNow();
	}

	flush(): void {
		this.persist();
	}

	private schedulePersist(): void {
		if (this.persistTimer) {
			return;
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			this.persistNow();
		}, DOWNLOAD_PERSIST_DELAY_MS);
	}

	private persistNow(): void {
		const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
		try {
			const payload = JSON.stringify(
				{
					downloads: this.downloads,
					history: this.history,
					settings: this.settings,
				},
				null,
				2
			);
			writeFileSync(temporaryPath, payload, "utf8");
			renameSync(temporaryPath, this.filePath);
		} catch {
			try {
				unlinkSync(temporaryPath);
			} catch {
				// The temporary file may not have been created.
			}
			// Browser operation remains useful if a profile directory becomes read-only.
		}
	}
}

function isHistoryEntry(value: unknown): value is BrowserHistoryEntry {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const item = value as Partial<BrowserHistoryEntry>;
	return (
		typeof item.id === "string" &&
		typeof item.title === "string" &&
		typeof item.url === "string" &&
		typeof item.visitedAt === "number"
	);
}

function isDownloadEntry(value: unknown): value is BrowserDownloadEntry {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const item = value as Partial<BrowserDownloadEntry>;
	return (
		typeof item.id === "string" &&
		typeof item.filename === "string" &&
		typeof item.url === "string" &&
		typeof item.path === "string" &&
		(item.state === "progressing" ||
			item.state === "completed" ||
			item.state === "cancelled" ||
			item.state === "interrupted")
	);
}

function finiteCoordinate(value: unknown): number | null {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : null;
}

function normalizeRect(rect: BrowserRect): BrowserRect | null {
	const x = finiteCoordinate(rect.x);
	const y = finiteCoordinate(rect.y);
	const width = finiteCoordinate(rect.width);
	const height = finiteCoordinate(rect.height);
	if (x === null || y === null || width === null || height === null) {
		return null;
	}
	if (width < 0 || height < 0 || width > 100_000 || height > 100_000) {
		return null;
	}
	return { height, width, x, y };
}

function unionRects(rects: BrowserRect[]): BrowserRect | null {
	if (rects.length === 0) {
		return null;
	}
	const left = Math.min(...rects.map((rect) => rect.x));
	const top = Math.min(...rects.map((rect) => rect.y));
	const right = Math.max(...rects.map((rect) => rect.x + rect.width));
	const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
	return { height: bottom - top, width: right - left, x: left, y: top };
}

function annotationStyle(
	style: BrowserStyleAdjust | undefined
): BrowserStyleAdjust | undefined {
	if (!style) {
		return undefined;
	}
	const out: BrowserStyleAdjust = {};
	for (const key of [
		"background_color",
		"color",
		"font_family",
		"font_size",
		"font_weight",
		"letter_spacing",
		"line_height",
		"margin",
		"padding",
	] as const) {
		const value = style[key];
		if (typeof value !== "string") {
			continue;
		}
		const trimmed = value.trim();
		if (
			trimmed.length > 0 &&
			trimmed.length <= 160 &&
			!/[;{}]|url\s*\(|expression\s*\(/i.test(trimmed)
		) {
			out[key] = trimmed;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function keyDescriptor(token: string): Record<string, string> {
	const normalized = token.trim();
	const lower = normalized.toLowerCase();
	const aliases: Record<string, { code: string; key: string }> = {
		backspace: { code: "Backspace", key: "Backspace" },
		cmd: { code: "MetaLeft", key: "Meta" },
		command: { code: "MetaLeft", key: "Meta" },
		control: { code: "ControlLeft", key: "Control" },
		ctrl: { code: "ControlLeft", key: "Control" },
		down: { code: "ArrowDown", key: "ArrowDown" },
		end: { code: "End", key: "End" },
		enter: { code: "Enter", key: "Enter" },
		escape: { code: "Escape", key: "Escape" },
		home: { code: "Home", key: "Home" },
		left: { code: "ArrowLeft", key: "ArrowLeft" },
		option: { code: "AltLeft", key: "Alt" },
		page_down: { code: "PageDown", key: "PageDown" },
		page_up: { code: "PageUp", key: "PageUp" },
		return: { code: "Enter", key: "Enter" },
		right: { code: "ArrowRight", key: "ArrowRight" },
		shift: { code: "ShiftLeft", key: "Shift" },
		tab: { code: "Tab", key: "Tab" },
		up: { code: "ArrowUp", key: "ArrowUp" },
	};
	const known = aliases[lower];
	if (known) {
		return known;
	}
	if (normalized.length === 1) {
		return { code: normalized.toUpperCase(), key: normalized };
	}
	if (/^f\d{1,2}$/i.test(normalized)) {
		return { code: normalized.toUpperCase(), key: normalized.toUpperCase() };
	}
	return { code: normalized, key: normalized };
}

/**
 * Electron-backed tab manager: each tab is a `WebContentsView` laid out below the
 * tab-strip renderer. Implements the same `TabManager` interface the control server
 * and its tests share.
 */
class ElectronTabManager implements TabManager {
	private readonly tabs: LiveTab[] = [];
	private active: string | null = null;
	private browserVisible = true;
	private deviceToolbar = false;

	constructor(
		private readonly win: BaseWindow,
		private readonly onChange: () => void,
		private readonly onNavigate: (tab: TabInfo) => void,
		private readonly onFindResult: (result: {
			activeMatchOrdinal: number;
			matches: number;
		}) => void
	) {
		win.on("resize", () => this.layout());
	}

	private layout(): void {
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

	private info(t: LiveTab): TabInfo {
		return {
			id: t.id,
			url: t.view.webContents.getURL(),
			title: t.view.webContents.getTitle(),
		};
	}

	private find(id: string): LiveTab | undefined {
		return this.tabs.find((t) => t.id === id);
	}

	private activeTab(): LiveTab | null {
		return this.active ? (this.find(this.active) ?? null) : null;
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
			webPreferences: { contextIsolation: true, nodeIntegration: false },
		});
		const tab: LiveTab = {
			annotations: [],
			id: randomUUID(),
			loading: true,
			refs: new Map(),
			snapshotId: null,
			view,
		};
		this.tabs.push(tab);
		this.win.contentView.addChildView(view);
		this.active = tab.id;
		view.webContents.setWindowOpenHandler((details) => {
			try {
				this.open(safeNavigationUrl(details.url));
			} catch {
				// Keep unsupported schemes out of the real browser surface.
			}
			return { action: "deny" };
		});
		view.webContents.loadURL(url).catch(() => undefined);
		view.webContents.on("page-title-updated", () => {
			this.onNavigate(this.info(tab));
			this.onChange();
		});
		view.webContents.on("did-start-loading", () => {
			tab.loading = true;
			this.onChange();
		});
		view.webContents.on("did-stop-loading", () => {
			tab.loading = false;
			this.onNavigate(this.info(tab));
			this.onChange();
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
			this.onNavigate(this.info(tab));
			this.onChange();
		});
		view.webContents.on("did-navigate-in-page", () => {
			this.onNavigate(this.info(tab));
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
		// Detach before the contents go away so the CDP session is released even if
		// the tab is reopened at the same address later.
		try {
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
		tab.view.webContents.loadURL(url).catch(() => undefined);
		this.layout();
		this.onChange();
		return this.info(tab);
	}

	back(): void {
		this.activeTab()?.view.webContents.goBack();
		this.onChange();
	}

	forward(): void {
		this.activeTab()?.view.webContents.goForward();
		this.onChange();
	}

	reload(): void {
		this.activeTab()?.view.webContents.reload();
		this.onChange();
	}

	findInPage(query: string): void {
		const tab = this.activeTab();
		if (!tab) {
			return;
		}
		if (query.trim() === "") {
			tab.view.webContents.stopFindInPage("clearSelection");
			this.onFindResult({ activeMatchOrdinal: 0, matches: 0 });
			return;
		}
		tab.view.webContents.findInPage(query, { findNext: true });
	}

	stopFindInPage(): void {
		this.activeTab()?.view.webContents.stopFindInPage("clearSelection");
	}

	zoom(action: "in" | "out" | "reset"): void {
		const contents = this.activeTab()?.view.webContents;
		if (!contents) {
			return;
		}
		const factor =
			action === "reset"
				? 1
				: Math.min(
						3,
						Math.max(
							0.5,
							contents.getZoomFactor() + (action === "in" ? 0.1 : -0.1)
						)
					);
		contents.setZoomFactor(Number(factor.toFixed(2)));
		this.onChange();
	}

	toggleDeviceToolbar(): void {
		const contents = this.activeTab()?.view.webContents;
		if (!contents) {
			return;
		}
		this.deviceToolbar = !this.deviceToolbar;
		if (this.deviceToolbar) {
			contents.enableDeviceEmulation({
				deviceScaleFactor: 2,
				scale: 1,
				screenPosition: "mobile",
				screenSize: { height: 812, width: 375 },
				viewPosition: { x: 0, y: 0 },
				viewSize: { height: 812, width: 375 },
			});
		} else {
			contents.disableDeviceEmulation();
		}
		this.onChange();
	}

	activeScreenshot(): Promise<Electron.NativeImage | null> {
		const tab = this.activeTab();
		return tab ? tab.view.webContents.capturePage() : Promise.resolve(null);
	}

	openDevTools(): void {
		this.activeTab()?.view.webContents.openDevTools({ mode: "detach" });
	}

	async screenshot(id: string): Promise<string | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const image = await tab.view.webContents.capturePage();
		return image.toPNG().toString("base64");
	}

	eval(id: string, expression: string): Promise<unknown> {
		const tab = this.find(id);
		if (!tab) {
			return Promise.reject(new Error("no such tab"));
		}
		// PRIVILEGED: Chromium's own JS evaluation in the tab's isolated web contents.
		// Grant-gated (`browser:control`) + bearer-authed + loopback-only upstream.
		return tab.view.webContents.executeJavaScript(expression, true);
	}

	// ── CDP-backed control (snapshot / click / type / scroll) ────────────────────
	//
	// All four go through `focusForControl`, which makes the target tab the ACTIVE
	// one before any CDP call. That is not cosmetic: an inactive tab's
	// `WebContentsView` is laid out at `{0,0,0,0}`, so `DOM.getBoxModel` returns a
	// degenerate rect and `Input.dispatchMouseEvent` hit-tests against a 0×0 region —
	// input that silently lands nowhere. Focusing first is what makes an explicit
	// `tab_id` behave the same as the active-tab default.

	private focusForControl(id: string): LiveTab | null {
		const tab = this.find(id);
		if (!tab) {
			return null;
		}
		if (this.active !== id) {
			this.active = id;
			this.layout();
			this.onChange();
		}
		return tab;
	}

	/**
	 * Send one CDP command over the tab's in-process debugger session, attaching on
	 * first use. `attach` throws when a session already exists (e.g. DevTools is
	 * open on those contents), so it is guarded by `isAttached` and its failure is
	 * turned into a legible error rather than an unhandled main-process rejection.
	 */
	private async cdp<T = unknown>(
		tab: LiveTab,
		method: string,
		params?: Record<string, unknown>
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
		return (await dbg.sendCommand(method, params)) as T;
	}

	/** Resolve a snapshot ref to its `backendDOMNodeId`, or fail with a fixable error. */
	private static resolveRef(tab: LiveTab, ref: string): number {
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

	async snapshot(id: string): Promise<SnapshotResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		await this.cdp(tab, "DOM.enable");
		// "Enables the accessibility domain which causes AXNodeIds to remain
		// consistent between method calls" — we key refs off `backendDOMNodeId`
		// regardless, but the domain must be on for `getFullAXTree`.
		await this.cdp(tab, "Accessibility.enable");
		const { nodes } = await this.cdp<{ nodes: AXNodeLike[] }>(
			tab,
			"Accessibility.getFullAXTree"
		);
		const built = buildSnapshot(nodes ?? []);
		tab.refs = built.refs;
		tab.snapshotId = randomUUID();
		return {
			elements: built.elements,
			snapshot_id: tab.snapshotId,
			tab: this.info(tab),
			truncated: built.truncated,
		};
	}

	async context(
		id: string,
		request: BrowserContextRequest = {}
	): Promise<BrowserContextResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const snapshot = await this.snapshot(id);
		if (!snapshot) {
			return null;
		}
		const selections = (request.selections ?? [])
			.slice(0, MAX_CONTEXT_SELECTIONS)
			.map(normalizeRect)
			.filter((rect): rect is BrowserRect => rect !== null);
		const targets = await this.inspectSelections(tab, selections);
		const viewport = await this.viewportMetrics(tab);
		const result: BrowserContextResult = {
			annotations: tab.annotations,
			page: this.info(tab),
			snapshot,
			viewport,
		};
		if (selections.length > 0) {
			result.selection = {
				rect: unionRects(selections) ?? selections[0],
				targets,
			};
		}
		if (request.include_screenshot !== false) {
			const image = await tab.view.webContents.capturePage();
			result.screenshot = {
				encoding: "base64",
				image: image.toPNG().toString("base64"),
				mime: "image/png",
			};
		}
		return result;
	}

	async annotate(
		id: string,
		input: BrowserAnnotationInput
	): Promise<BrowserAnnotation | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const rect = normalizeRect(input.rect);
		if (!rect) {
			throw new RefError("annotation rect is invalid");
		}
		const selections = (input.selections ?? [rect])
			.slice(0, MAX_CONTEXT_SELECTIONS)
			.map(normalizeRect)
			.filter((selection): selection is BrowserRect => selection !== null);
		const targets = await this.inspectSelections(tab, selections);
		const targetRects = targets.map((target) => target.rect);
		const storedRect =
			input.kind === "element" && targets.length === 1
				? targets[0].rect
				: input.kind === "elements" && targetRects.length > 0
					? (unionRects(targetRects) ?? rect)
					: rect;
		const annotation: BrowserAnnotation = {
			comment: input.comment.trim().slice(0, MAX_ANNOTATION_COMMENT_LENGTH),
			created_at: new Date().toISOString(),
			id: randomUUID(),
			kind: input.kind,
			rect: storedRect,
			targets,
		};
		const style = annotationStyle(input.style);
		if (style) {
			annotation.style = style;
		}
		tab.annotations = [...tab.annotations, annotation];
		return annotation;
	}

	clearAnnotations(id: string, annotationId?: string): boolean | null {
		const tab = this.find(id);
		if (!tab) {
			return null;
		}
		if (!annotationId) {
			tab.annotations = [];
			return true;
		}
		const next = tab.annotations.filter(
			(annotation) => annotation.id !== annotationId
		);
		const removed = next.length !== tab.annotations.length;
		tab.annotations = next;
		return removed;
	}

	async hover(
		id: string,
		ref: string
	): Promise<BrowserCoordinateAction | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const backendNodeId = ElectronTabManager.resolveRef(tab, ref);
		const point = await this.pointFor(tab, backendNodeId, ref);
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "none",
			buttons: 0,
			clickCount: 0,
			type: "mouseMoved",
			x: point.x,
			y: point.y,
		});
		return { ok: true, tab: this.info(tab), x: point.x, y: point.y };
	}

	async clickAt(
		id: string,
		x: number,
		y: number,
		button: BrowserMouseButton,
		count: number
	): Promise<BrowserCoordinateAction | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const point = await this.coordinatePoint(tab, x, y);
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "none",
			buttons: 0,
			clickCount: 0,
			type: "mouseMoved",
			x: point.x,
			y: point.y,
		});
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button,
			buttons: 1,
			clickCount: count,
			type: "mousePressed",
			x: point.x,
			y: point.y,
		});
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button,
			buttons: 0,
			clickCount: count,
			type: "mouseReleased",
			x: point.x,
			y: point.y,
		});
		return { ok: true, tab: this.info(tab), x: point.x, y: point.y };
	}

	async key(
		id: string,
		keys: string[]
	): Promise<BrowserCoordinateAction | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const descriptors = keys.map(keyDescriptor);
		for (const descriptor of descriptors) {
			await this.cdp(tab, "Input.dispatchKeyEvent", {
				...descriptor,
				type: "keyDown",
			});
		}
		for (const descriptor of [...descriptors].reverse()) {
			await this.cdp(tab, "Input.dispatchKeyEvent", {
				...descriptor,
				type: "keyUp",
			});
		}
		return { ok: true, tab: this.info(tab) };
	}

	async drag(
		id: string,
		from: { x: number; y: number },
		to: { x: number; y: number }
	): Promise<BrowserCoordinateAction | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const start = await this.coordinatePoint(tab, from.x, from.y);
		const end = await this.coordinatePoint(tab, to.x, to.y);
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "none",
			buttons: 0,
			clickCount: 0,
			type: "mouseMoved",
			x: start.x,
			y: start.y,
		});
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "left",
			buttons: 1,
			clickCount: 1,
			type: "mousePressed",
			x: start.x,
			y: start.y,
		});
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "left",
			buttons: 1,
			clickCount: 1,
			type: "mouseMoved",
			x: end.x,
			y: end.y,
		});
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "left",
			buttons: 0,
			clickCount: 1,
			type: "mouseReleased",
			x: end.x,
			y: end.y,
		});
		return { ok: true, tab: this.info(tab), x: end.x, y: end.y };
	}

	async click(id: string, ref: string): Promise<ActionResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const backendNodeId = ElectronTabManager.resolveRef(tab, ref);
		const point = await this.pointFor(tab, backendNodeId, ref);
		// Move first: a page that only reveals its target on hover (menus, custom
		// dropdowns) never sees the press otherwise.
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "none",
			buttons: 0,
			clickCount: 0,
			type: "mouseMoved",
			x: point.x,
			y: point.y,
		});
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "left",
			buttons: 1,
			clickCount: 1,
			type: "mousePressed",
			x: point.x,
			y: point.y,
		});
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "left",
			buttons: 0,
			clickCount: 1,
			type: "mouseReleased",
			x: point.x,
			y: point.y,
		});
		return { ok: true, tab: this.info(tab), x: point.x, y: point.y };
	}

	async type(
		id: string,
		ref: string,
		text: string,
		submit: boolean,
		replace = false
	): Promise<ActionResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const backendNodeId = ElectronTabManager.resolveRef(tab, ref);
		await this.cdp(tab, "DOM.enable");
		await this.scrollIntoView(tab, backendNodeId);
		try {
			await this.cdp(tab, "DOM.focus", { backendNodeId });
		} catch (e) {
			throw new RefError(
				`element '${ref}' cannot take keyboard focus (${e instanceof Error ? e.message : String(e)})`
			);
		}
		// `DOM.focus` only throws for a NON-FOCUSABLE node, which is a much weaker
		// condition than "can accept text": a link, a `tabindex` div, a disabled or
		// read-only input all focus happily and then discard the insertion. Without
		// this check the route returns `{ok: true}` for a write that never landed —
		// a silent no-op the caller cannot distinguish from success.
		await this.assertCanAcceptText(tab, ref);
		if (replace) {
			// `Input.insertText` replaces the current SELECTION, so selecting the
			// field's whole contents first turns append into replace. Done through
			// the editing pipeline (not by assigning `.value`) so React-controlled
			// inputs still observe a real `input` event.
			await this.selectAllInFocused(tab);
			if (text.length === 0) {
				// Nothing to insert, so nothing would replace the selection. Delete it
				// explicitly, otherwise `replace: true, text: ""` — the natural way to
				// ask for "clear this field" — would leave the value untouched.
				await this.cdp(tab, "Input.dispatchKeyEvent", {
					...DELETE_KEY,
					type: "keyDown",
				});
				await this.cdp(tab, "Input.dispatchKeyEvent", {
					...DELETE_KEY,
					type: "keyUp",
				});
			}
		}
		if (text.length > 0) {
			// `Input.insertText` "emulates inserting text that doesn't come from a key
			// press": it goes through the editing pipeline (so React-controlled inputs
			// see a real `input` event) but fires no `keydown`. It inserts at the caret,
			// replacing whatever is selected — which is why `replace` above works by
			// selecting first rather than by clearing separately.
			await this.cdp(tab, "Input.insertText", { text });
		}
		if (submit) {
			// The one keystroke that must be a real key event — forms and
			// search boxes listen for `keydown`, which `insertText` does not produce.
			await this.cdp(tab, "Input.dispatchKeyEvent", {
				...ENTER_KEY,
				text: "\r",
				type: "keyDown",
				unmodifiedText: "\r",
			});
			await this.cdp(tab, "Input.dispatchKeyEvent", {
				...ENTER_KEY,
				type: "keyUp",
			});
		}
		return { ok: true, tab: this.info(tab) };
	}

	async scroll(
		id: string,
		direction: ScrollDirection,
		amount?: number
	): Promise<ActionResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const viewport = await this.viewport(tab);
		const { deltaX, deltaY } = scrollDelta(direction, amount, viewport);
		const x = Math.round(viewport.width / 2);
		const y = Math.round(viewport.height / 2);
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "none",
			buttons: 0,
			deltaX,
			deltaY,
			type: "mouseWheel",
			x,
			y,
		});
		return { ok: true, tab: this.info(tab), x, y };
	}

	private async inspectSelections(
		tab: LiveTab,
		selections: BrowserRect[]
	): Promise<BrowserElementContext[]> {
		if (selections.length === 0) {
			return [];
		}
		await this.cdp(tab, "DOM.enable");
		const inspected: InspectedElement[] = [];
		for (const rect of selections) {
			const points =
				rect.width === 0 && rect.height === 0
					? [{ x: rect.x, y: rect.y }]
					: [
							{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
							{ x: rect.x + 1, y: rect.y + 1 },
							{ x: rect.x + Math.max(0, rect.width - 1), y: rect.y + 1 },
						];
			for (const point of points) {
				const element = await this.inspectPoint(tab, point.x, point.y);
				if (!element) {
					continue;
				}
				if (
					!inspected.some(
						(existing) =>
							existing.selector === element.selector &&
							existing.xpath === element.xpath
					)
				) {
					inspected.push(element);
				}
			}
		}
		return inspected.map((element) => this.publicElement(tab, element));
	}

	private async inspectPoint(
		tab: LiveTab,
		x: number,
		y: number
	): Promise<InspectedElement | null> {
		let location: { backendNodeId?: number };
		try {
			location = await this.cdp(tab, "DOM.getNodeForLocation", {
				includeUserAgentShadowDOM: true,
				x,
				y,
			});
		} catch {
			return null;
		}
		if (typeof location.backendNodeId !== "number") {
			return null;
		}
		const expression = `(() => {
			const x = ${JSON.stringify(x)};
			const y = ${JSON.stringify(y)};
			const root = document.elementFromPoint(x, y);
			if (!(root instanceof Element)) return null;
			const cssEscape = (value) => {
				if (globalThis.CSS && typeof CSS.escape === "function") return CSS.escape(value);
				return value.replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
			};
			const selectorFor = (element) => {
				const parts = [];
				let current = element;
				let depth = 0;
				while (current instanceof Element && depth < 8) {
					if (current.id) {
						parts.unshift("#" + cssEscape(current.id));
						break;
					}
					let part = current.tagName.toLowerCase();
					const classes = Array.from(current.classList).slice(0, 2);
					if (classes.length) part += classes.map((name) => "." + cssEscape(name)).join("");
					const parent = current.parentElement;
					if (parent) {
						const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === current.tagName);
						if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
					}
					parts.unshift(part);
					current = current.parentElement;
					depth += 1;
				}
				return parts.join(" > ");
			};
			const xpathFor = (element) => {
				const parts = [];
				let current = element;
				while (current instanceof Element) {
					let index = 1;
					let sibling = current.previousElementSibling;
					while (sibling) {
						if (sibling.tagName === current.tagName) index += 1;
						sibling = sibling.previousElementSibling;
					}
					parts.unshift(current.tagName.toLowerCase() + "[" + index + "]");
					current = current.parentElement;
				}
				return "/" + parts.join("/");
			};
			const attributes = {};
			for (const attribute of Array.from(root.attributes).slice(0, 40)) {
				attributes[attribute.name] = attribute.value.slice(0, 300);
			}
			const style = getComputedStyle(root);
			const styleNames = ${JSON.stringify(INSPECTION_STYLE_PROPERTIES)};
			const computed_styles = Object.fromEntries(styleNames.map((name) => [name, style.getPropertyValue(name)]));
			const rect = root.getBoundingClientRect();
			const rawText = (root.innerText || root.textContent || "").trim();
			let component;
			let current = root;
			while (current && !component) {
				const fiberKey = Object.keys(current).find((key) => key.startsWith("__reactFiber$"));
				let fiber = fiberKey ? current[fiberKey] : null;
				for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
					const type = fiber.elementType || fiber.type;
					if (typeof type === "function") component = type.displayName || type.name;
					if (component) break;
				}
				current = current.parentElement;
			}
			return {
				attributes,
				backend_node_id: ${location.backendNodeId},
				component: typeof component === "string" ? component.slice(0, 120) : undefined,
				computed_styles,
				content_preview: rawText.slice(0, 400) || undefined,
				name: (root.getAttribute("aria-label") || root.getAttribute("title") || rawText).slice(0, 240) || undefined,
				role: root.getAttribute("role") || root.tagName.toLowerCase(),
				selector: selectorFor(root),
				tag: root.tagName.toLowerCase(),
				text: rawText.slice(0, 1000) || undefined,
				xpath: xpathFor(root),
				rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			};
		})()`;
		try {
			const evaluated = await this.cdp<RuntimeValue<InspectedElement | null>>(
				tab,
				"Runtime.evaluate",
				{ expression, returnByValue: true }
			);
			return evaluated.result?.value ?? null;
		} catch {
			return null;
		}
	}

	private publicElement(
		tab: LiveTab,
		element: InspectedElement
	): BrowserElementContext {
		const ref = element.backend_node_id
			? [...tab.refs.entries()].find(
					([, backendNodeId]) => backendNodeId === element.backend_node_id
				)?.[0]
			: undefined;
		const { backend_node_id: _backendNodeId, ...publicElement } = element;
		return ref ? { ...publicElement, ref } : publicElement;
	}

	private async coordinatePoint(
		tab: LiveTab,
		x: number,
		y: number
	): Promise<{ x: number; y: number }> {
		const point = { x: finiteCoordinate(x), y: finiteCoordinate(y) };
		if (point.x === null || point.y === null) {
			throw new RefError("browser coordinates must be finite numbers");
		}
		const viewport = await this.viewport(tab);
		if (
			point.x < 0 ||
			point.y < 0 ||
			point.x > viewport.width ||
			point.y > viewport.height
		) {
			throw new RefError(
				`browser coordinates (${point.x}, ${point.y}) are outside the ${viewport.width}x${viewport.height} viewport`
			);
		}
		return { x: point.x, y: point.y };
	}

	/** Viewport size in CSS pixels; the `css*` metrics, since the rest are device px. */
	private async viewportMetrics(tab: LiveTab): Promise<ViewportMetrics> {
		try {
			const metrics = await this.cdp<{
				cssLayoutViewport?: { clientHeight?: number; clientWidth?: number };
				cssVisualViewport?: {
					clientHeight?: number;
					clientWidth?: number;
					pageX?: number;
					pageY?: number;
				};
			}>(tab, "Page.getLayoutMetrics");
			const vp = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
			if (
				typeof vp?.clientWidth === "number" &&
				typeof vp.clientHeight === "number" &&
				vp.clientWidth > 0 &&
				vp.clientHeight > 0
			) {
				return {
					height: vp.clientHeight,
					scroll_x:
						"pageX" in vp && typeof vp.pageX === "number" ? vp.pageX : 0,
					scroll_y:
						"pageY" in vp && typeof vp.pageY === "number" ? vp.pageY : 0,
					width: vp.clientWidth,
				};
			}
		} catch {
			// Fall through to the window-derived fallback below.
		}
		const [width, height] = this.win.getContentSize();
		return width > 0 && height > BROWSER_CHROME_HEIGHT
			? {
					height: height - BROWSER_CHROME_HEIGHT,
					scroll_x: 0,
					scroll_y: 0,
					width,
				}
			: { ...FALLBACK_VIEWPORT, scroll_x: 0, scroll_y: 0 };
	}

	private async viewport(
		tab: LiveTab
	): Promise<{ height: number; width: number }> {
		const metrics = await this.viewportMetrics(tab);
		return { height: metrics.height, width: metrics.width };
	}

	/** Best-effort scroll-into-view; a node that refuses still gets a box-model try. */
	/**
	 * Refuse a `type` whose focused element definitively cannot accept text.
	 *
	 * Probes the EFFECTIVE focused element (`document.activeElement`) rather than
	 * the referenced node, because that is exactly where `Input.insertText`
	 * commits — and it is what survives focus delegation (a `<label for>`, a custom
	 * element with `delegatesFocus`), where the referenced node and the node that
	 * actually receives text differ.
	 *
	 * Fails OPEN: anything the probe cannot see through (a closed shadow root, a
	 * cross-origin iframe, an evaluation error) is allowed through. A false
	 * rejection would break working calls, which is worse than the silent no-op
	 * this exists to catch.
	 */
	private async assertCanAcceptText(tab: LiveTab, ref: string): Promise<void> {
		const expression = `(() => {
			let el = document.activeElement;
			// document.activeElement reports the shadow HOST, not the focused node
			// inside it, so a web component wrapping an <input> would look like a
			// non-editable custom element. Descend through OPEN roots to the node that
			// actually has focus. A CLOSED root leaves \`shadowRoot === null\`, which the
			// custom-element check below sends to "unknown" (fail open).
			while (el && el.shadowRoot && el.shadowRoot.activeElement) {
				el = el.shadowRoot.activeElement;
			}
			if (!el || el === document.body) return { verdict: "unknown" };
			const tag = el.tagName;
			if (tag === "IFRAME" || tag === "FRAME" || el.shadowRoot === null && tag.includes("-")) {
				return { verdict: "unknown" };
			}
			if (el.isContentEditable) return { verdict: "ok" };
			if (tag === "TEXTAREA" || tag === "INPUT") {
				if (el.disabled) return { verdict: "no", why: "is disabled" };
				if (el.readOnly) return { verdict: "no", why: "is read-only" };
				if (tag === "INPUT") {
					// The input types that hold no caret-editable text. Everything else
					// (text/search/url/email/tel/password/number/date/…) does.
					const opaque = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
					const t = (el.getAttribute("type") || "text").toLowerCase();
					if (opaque.includes(t)) return { verdict: "no", why: "is an <input type=" + t + ">" };
				}
				return { verdict: "ok" };
			}
			return { verdict: "no", why: "is a <" + tag.toLowerCase() + "> that is not editable" };
		})()`;
		let verdict: { verdict?: string; why?: string } | undefined;
		try {
			const res = await this.cdp<{ result?: { value?: unknown } }>(
				tab,
				"Runtime.evaluate",
				{ expression, returnByValue: true }
			);
			verdict = res?.result?.value as { verdict?: string; why?: string };
		} catch {
			return; // fail open — see the doc comment
		}
		if (verdict?.verdict === "no") {
			throw new RefError(
				`element '${ref}' cannot accept text: it ${verdict.why ?? "is not editable"}. ` +
					"Focusing it succeeds but the text would be silently discarded — snapshot again and pick the input itself."
			);
		}
	}

	/**
	 * Select everything in the focused editable so the next `Input.insertText`
	 * overwrites it. Uses the editing pipeline (`selectAll`) rather than assigning
	 * `.value`, so a React-controlled input still sees a real `input` event.
	 */
	private async selectAllInFocused(tab: LiveTab): Promise<void> {
		// `Input.dispatchKeyEvent` with the platform's select-all chord is unreliable
		// across platforms (Cmd vs Ctrl); the editing command is not.
		await this.cdp(tab, "Runtime.evaluate", {
			expression: `(() => {
				// Same shadow-host descent as the editability probe: selecting the
				// HOST's contents would make the following insertText replace the wrong
				// range, which is a silent wrong-write rather than a visible failure.
				let el = document.activeElement;
				while (el && el.shadowRoot && el.shadowRoot.activeElement) {
					el = el.shadowRoot.activeElement;
				}
				if (!el) return false;
				if (typeof el.select === "function") { el.select(); return true; }
				const r = document.createRange();
				r.selectNodeContents(el);
				const s = window.getSelection();
				s.removeAllRanges();
				s.addRange(r);
				return true;
			})()`,
			returnByValue: true,
		});
	}

	private async scrollIntoView(
		tab: LiveTab,
		backendNodeId: number
	): Promise<void> {
		try {
			await this.cdp(tab, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
		} catch {
			// Not fatal on its own — `getBoxModel` below decides whether the element
			// is actually reachable, and its error message is the useful one.
		}
	}

	/** Viewport point to dispatch input at for a referenced element. */
	private async pointFor(
		tab: LiveTab,
		backendNodeId: number,
		ref: string
	): Promise<{ x: number; y: number }> {
		await this.cdp(tab, "DOM.enable");
		await this.scrollIntoView(tab, backendNodeId);
		let model: { content?: unknown } | undefined;
		try {
			const box = await this.cdp<{ model?: { content?: unknown } }>(
				tab,
				"DOM.getBoxModel",
				{ backendNodeId }
			);
			model = box?.model;
		} catch (e) {
			throw new RefError(
				`element '${ref}' has no layout box — it is hidden or gone (${e instanceof Error ? e.message : String(e)}); re-run snapshot`
			);
		}
		const point = quadCenter(model?.content);
		if (!point) {
			throw new RefError(
				`element '${ref}' has an empty layout box (hidden or zero-sized); re-run snapshot`
			);
		}
		return point;
	}

	title(id: string): string | null {
		const tab = this.find(id);
		return tab ? tab.view.webContents.getTitle() : null;
	}
}

interface BrowserRuntime {
	overlayVisible: boolean;
	store: BrowserStateStore;
	strip: WebContents;
	stripView: WebContentsView;
	surface: BrowserSurface;
	tabs: ElectronTabManager;
	win: BaseWindow;
}

let runtime: BrowserRuntime | null = null;

function layoutShell(): void {
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

function createWindow(): {
	win: BaseWindow;
	strip: WebContents;
	stripView: WebContentsView;
} {
	const win = new BaseWindow({
		height: 800,
		show: true,
		title: "Ryu Browser",
		width: 1200,
	});
	const strip = new WebContentsView({
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
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

function setChromeSurface(surface: BrowserSurface): void {
	if (!runtime) {
		return;
	}
	runtime.surface = surface;
	runtime.overlayVisible = false;
	runtime.tabs.setBrowserVisible(surface === "browser");
	layoutShell();
	emitState();
}

function emitState(): void {
	if (!runtime) {
		return;
	}
	// The active Chromium view is added after the shell view. Re-add the shell as
	// the same child to keep menus, find, and downloads popovers above the page.
	runtime.win.contentView.removeChildView(runtime.stripView);
	runtime.win.contentView.addChildView(runtime.stripView);
	runtime.strip.send("ryu-browser:tabs", runtime.tabs.list());
	runtime.strip.send("ryu-browser:state", getBrowserState());
}

function getBrowserState(): BrowserState {
	if (!runtime) {
		throw new Error("browser runtime is not ready");
	}
	const active = runtime.tabs
		.state()
		.find((tab) => tab.id === runtime?.tabs.activeId());
	return {
		activeId: runtime.tabs.activeId(),
		activeTitle: active?.title ?? "",
		activeUrl: active?.url ?? "about:blank",
		cdpRestartRequired:
			runtime.store.getSettings().developerCdp !== remoteCdpEnabled,
		deviceToolbar: runtime.tabs.isDeviceToolbarEnabled(),
		downloads: runtime.store.getDownloads(),
		history: runtime.store.getHistory(),
		settings: runtime.store.getSettings(),
		surface: runtime.surface,
		tabs: runtime.tabs.state(),
	};
}

function normalizedNavigationUrl(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new Error("Enter a URL");
	}
	if (/\s/.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
		return safeNavigationUrl(
			`https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
		);
	}
	return safeNavigationUrl(
		/^(?:https?:|about:)/i.test(trimmed) ? trimmed : `https://${trimmed}`
	);
}

function updateSetting(key: unknown, value: unknown): void {
	if (!runtime || typeof key !== "string") {
		throw new Error("Invalid browser setting");
	}
	switch (key) {
		case "allowControl":
		case "askWhereToSave":
		case "developerCdp":
			if (typeof value !== "boolean") {
				throw new Error("Invalid boolean browser setting");
			}
			runtime.store.setSetting(key, value);
			return;
		case "annotationScreenshots":
			if (value !== "always" && value !== "ask" && value !== "never") {
				throw new Error("Invalid annotation screenshot policy");
			}
			runtime.store.setSetting(key, value);
			return;
		case "approval":
		case "historyAccess":
			if (value !== "always-allow" && value !== "always-ask") {
				throw new Error("Invalid permission policy");
			}
			runtime.store.setSetting(key, value);
			return;
		case "webLinkDestination":
		case "localLinkDestination":
			if (value !== "default" && value !== "ryu") {
				throw new Error("Invalid link destination");
			}
			runtime.store.setSetting(key, value);
			return;
		default:
			throw new Error(
				"This browser setting is managed by its dedicated control"
			);
	}
}

function permissionOrigin(
	contents: WebContents,
	details: unknown
): string | null {
	const candidate = details as { requestingUrl?: unknown };
	const raw =
		typeof candidate.requestingUrl === "string"
			? candidate.requestingUrl
			: contents.getURL();
	try {
		const parsed = new URL(raw);
		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? parsed.origin
			: null;
	} catch {
		return null;
	}
}

function permissionKeys(
	permission: string,
	details: unknown
): BrowserPermission[] {
	if (
		permission === "geolocation" ||
		permission === "notifications" ||
		permission === "clipboard-read"
	) {
		return [permission];
	}
	if (permission !== "media") {
		return [];
	}
	const request = details as { mediaType?: unknown; mediaTypes?: unknown };
	const mediaTypes = Array.isArray(request.mediaTypes)
		? request.mediaTypes
		: [request.mediaType];
	const keys: BrowserPermission[] = [];
	if (mediaTypes.includes("video")) {
		keys.push("camera");
	}
	if (mediaTypes.includes("audio")) {
		keys.push("microphone");
	}
	return keys.length > 0 ? keys : ["camera", "microphone"];
}

function installPermissionHandlers(): void {
	if (!runtime) {
		return;
	}
	const browserSession = session.defaultSession;
	browserSession.setPermissionCheckHandler(
		(_contents, permission, origin, details) => {
			const keys = permissionKeys(permission, details);
			if (keys.length === 0) {
				return false;
			}
			return keys.every((key) => {
				const explicit = runtime?.store.permissionFor(origin, key);
				return (
					explicit === "allow" ||
					(explicit === null &&
						runtime?.store.getSettings().approval === "always-allow")
				);
			});
		}
	);
	browserSession.setPermissionRequestHandler(
		async (contents, permission, callback, details) => {
			const origin = permissionOrigin(contents, details);
			const keys = permissionKeys(permission, details);
			if (!(runtime && origin && keys.length > 0)) {
				callback(false);
				return;
			}
			const decisions = keys.map((key) =>
				runtime?.store.permissionFor(origin, key)
			);
			if (decisions.includes("deny")) {
				callback(false);
				return;
			}
			if (decisions.every((decision) => decision === "allow")) {
				callback(true);
				return;
			}
			if (runtime.store.getSettings().approval === "always-allow") {
				callback(true);
				return;
			}
			const result = await dialog.showMessageBox(runtime.win, {
				buttons: ["Allow", "Block"],
				cancelId: 1,
				detail: `${origin} requested access to ${keys.join(" and ")}.`,
				message: "Allow this site permission?",
				title: "Ryu Browser permission",
				type: "question",
			});
			callback(result.response === 0);
		}
	);
}

function installDownloadHandlers(): void {
	const browserSession = session.defaultSession;
	browserSession.on("will-download", (_event, item, _webContents) => {
		if (!runtime) {
			item.cancel();
			return;
		}
		const id = randomUUID();
		const now = Date.now();
		const filename = safeDownloadFilename(item.getFilename());
		const initial: BrowserDownloadEntry = {
			filename,
			id,
			path: "",
			percent: 0,
			receivedBytes: 0,
			state: "progressing",
			totalBytes: item.getTotalBytes(),
			updatedAt: now,
			url: item.getURL(),
		};
		runtime.store.upsertDownload(initial);
		emitState();

		const persistDownload = (state: BrowserDownloadEntry["state"]): void => {
			const totalBytes = item.getTotalBytes();
			const receivedBytes = item.getReceivedBytes();
			runtime?.store.upsertDownload(
				{
					...initial,
					path: item.getSavePath(),
					percent:
						totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0,
					receivedBytes,
					state,
					totalBytes,
					updatedAt: Date.now(),
				},
				{ defer: state === "progressing" }
			);
			emitState();
		};
		item.on("updated", () =>
			persistDownload(
				item.getState() === "interrupted" ? "interrupted" : "progressing"
			)
		);
		item.once("done", (_doneEvent, result) => {
			persistDownload(
				result === "completed"
					? "completed"
					: result === "cancelled"
						? "cancelled"
						: "interrupted"
			);
		});

		const settings = runtime.store.getSettings();
		const defaultPath = join(settings.downloadDirectory, filename);
		if (!settings.askWhereToSave) {
			item.setSavePath(defaultPath);
			return;
		}
		dialog
			.showSaveDialog(runtime.win, {
				defaultPath,
				buttonLabel: "Save",
				nameFieldLabel: "Save download as",
			})
			.then((result) => {
				if (result.canceled || !result.filePath) {
					item.cancel();
					return;
				}
				item.setSavePath(result.filePath);
			})
			.catch(() => item.cancel());
	});
}

async function saveActiveScreenshot(): Promise<{
	saved: boolean;
	path?: string;
}> {
	if (!runtime) {
		return { saved: false };
	}
	const image = await runtime.tabs.activeScreenshot();
	if (!image) {
		return { saved: false };
	}
	const result = await dialog.showSaveDialog(runtime.win, {
		buttonLabel: "Save screenshot",
		defaultPath: join(
			runtime.store.getSettings().downloadDirectory,
			`ryu-browser-${Date.now()}.png`
		),
		filters: [{ extensions: ["png"], name: "PNG image" }],
	});
	if (result.canceled || !result.filePath) {
		return { saved: false };
	}
	writeFileSync(result.filePath, image.toPNG());
	return { path: result.filePath, saved: true };
}

async function importCookies(): Promise<{
	imported: number;
	message?: string;
}> {
	if (!runtime) {
		return { imported: 0, message: "Browser sidecar unavailable" };
	}
	const selected = await dialog.showOpenDialog(runtime.win, {
		filters: [{ extensions: ["json"], name: "Browser export" }],
		properties: ["openFile"],
		title: "Import cookies",
	});
	if (selected.canceled || !selected.filePaths[0]) {
		return { imported: 0, message: "Import cancelled" };
	}
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(selected.filePaths[0], "utf8")
		);
		const list = Array.isArray(parsed)
			? parsed
			: typeof parsed === "object" &&
					parsed !== null &&
					Array.isArray((parsed as { cookies?: unknown }).cookies)
				? (parsed as { cookies: unknown[] }).cookies
				: [];
		let imported = 0;
		for (const value of list.slice(0, 500)) {
			if (typeof value !== "object" || value === null) {
				continue;
			}
			const cookie = value as Record<string, unknown>;
			const name = typeof cookie.name === "string" ? cookie.name : "";
			const cookieValue = typeof cookie.value === "string" ? cookie.value : "";
			const domain = typeof cookie.domain === "string" ? cookie.domain : "";
			const path =
				typeof cookie.path === "string" && cookie.path.startsWith("/")
					? cookie.path
					: "/";
			const url = cookieImportUrl(cookie.url, domain, path);
			if (!(name && url && /^https?:\/\//i.test(url))) {
				continue;
			}
			await session.defaultSession.cookies.set({
				domain: domain || undefined,
				expirationDate:
					typeof cookie.expirationDate === "number"
						? cookie.expirationDate
						: undefined,
				httpOnly: cookie.httpOnly === true,
				name,
				path,
				sameSite:
					cookie.sameSite === "strict" ||
					cookie.sameSite === "lax" ||
					cookie.sameSite === "no_restriction"
						? cookie.sameSite
						: "unspecified",
				secure: cookie.secure === true,
				url,
				value: cookieValue,
			});
			imported += 1;
		}
		return {
			imported,
			message:
				imported > 0
					? `${imported} cookies imported. Passwords remain protected by the OS password manager.`
					: "No compatible cookies found in that export.",
		};
	} catch {
		return { imported: 0, message: "That browser export could not be read." };
	}
}

function registerIpcHandlers(): void {
	if (!runtime) {
		return;
	}
	ipcMain.handle(
		"ryu-browser:add-site-permission",
		(_event, input: unknown) => {
			if (typeof input !== "object" || input === null) {
				throw new Error("Invalid site permission");
			}
			const candidate = input as Partial<SitePermission>;
			if (
				typeof candidate.origin !== "string" ||
				!isBrowserPermission(candidate.permission) ||
				(candidate.decision !== "allow" && candidate.decision !== "deny")
			) {
				throw new Error("Invalid site permission");
			}
			const origin = new URL(candidate.origin);
			if (origin.protocol !== "http:" && origin.protocol !== "https:") {
				throw new Error("Site permissions require an http or https origin");
			}
			runtime?.store.setSitePermission({
				origin: origin.origin,
				permission: candidate.permission,
				decision: candidate.decision,
			});
			emitState();
			return getBrowserState();
		}
	);
	ipcMain.handle("ryu-browser:back", () => {
		runtime?.tabs.back();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:choose-download-directory", async () => {
		if (!runtime) {
			return null;
		}
		const result = await dialog.showOpenDialog(runtime.win, {
			properties: ["createDirectory", "openDirectory"],
			title: "Choose download location",
		});
		if (result.canceled || !result.filePaths[0]) {
			return null;
		}
		runtime.store.setSetting("downloadDirectory", result.filePaths[0]);
		session.defaultSession.setDownloadPath(result.filePaths[0]);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:clear-browsing-data", async () => {
		await session.defaultSession.clearStorageData();
		runtime?.store.clearHistory();
		runtime?.store.clearDownloads();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:clear-downloads", () => {
		runtime?.store.clearDownloads();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:clear-history", () => {
		runtime?.store.clearHistory();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:close", (_event, id: string) => {
		runtime?.tabs.close(id);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:find", (_event, query: string) => {
		runtime?.tabs.findInPage(query);
	});
	ipcMain.handle("ryu-browser:forward", () => {
		runtime?.tabs.forward();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:get-state", () => getBrowserState());
	ipcMain.handle("ryu-browser:import-cookies", () => importCookies());
	ipcMain.handle("ryu-browser:list", () => runtime?.tabs.list() ?? []);
	ipcMain.handle("ryu-browser:navigate", (_event, value: string) => {
		const url = normalizedNavigationUrl(value);
		const id = runtime?.tabs.activeId();
		if (id) {
			runtime?.tabs.navigate(id, url);
		} else {
			runtime?.tabs.open(url);
		}
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:open", (_event, value?: string) => {
		const url = value ? normalizedNavigationUrl(value) : "about:blank";
		runtime?.tabs.open(url);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:open-downloads-folder", async () => {
		if (runtime) {
			await shell.openPath(runtime.store.getSettings().downloadDirectory);
		}
	});
	ipcMain.handle("ryu-browser:open-devtools", () =>
		runtime?.tabs.openDevTools()
	);
	ipcMain.handle(
		"ryu-browser:remove-site-permission",
		(_event, origin: string, permission: unknown) => {
			if (!(runtime && isBrowserPermission(permission))) {
				throw new Error("Invalid site permission");
			}
			runtime.store.removeSitePermission(origin, permission);
			emitState();
			return getBrowserState();
		}
	);
	ipcMain.handle("ryu-browser:reload", () => {
		runtime?.tabs.reload();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:select", (_event, id: string) => {
		if (!runtime?.tabs.select(id)) {
			throw new Error("No such browser tab");
		}
		emitState();
		return getBrowserState();
	});
	ipcMain.handle(
		"ryu-browser:set-overlay-visible",
		(_event, visible: unknown) => {
			if (!runtime || typeof visible !== "boolean") {
				throw new Error("Invalid browser overlay state");
			}
			runtime.overlayVisible = visible;
			layoutShell();
		}
	);
	ipcMain.handle("ryu-browser:set-cdp-enabled", (_event, enabled: boolean) => {
		if (!runtime || typeof enabled !== "boolean") {
			throw new Error("Invalid CDP setting");
		}
		runtime.store.setSetting("developerCdp", enabled);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle(
		"ryu-browser:set-setting",
		(_event, key: unknown, value: unknown) => {
			updateSetting(key, value);
			emitState();
			return getBrowserState();
		}
	);
	ipcMain.handle("ryu-browser:set-surface", (_event, surface: unknown) => {
		const valid: BrowserSurface[] = [
			"browser",
			"settings",
			"history",
			"downloads",
			"passwords",
			"permissions",
		];
		if (!valid.includes(surface as BrowserSurface)) {
			throw new Error("Invalid browser surface");
		}
		setChromeSurface(surface as BrowserSurface);
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:show-screenshot", () => saveActiveScreenshot());
	ipcMain.handle("ryu-browser:stop-find", () => runtime?.tabs.stopFindInPage());
	ipcMain.handle("ryu-browser:toggle-device-toolbar", () => {
		runtime?.tabs.toggleDeviceToolbar();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle(
		"ryu-browser:zoom",
		(_event, action: "in" | "out" | "reset") => {
			if (action !== "in" && action !== "out" && action !== "reset") {
				throw new Error("Invalid zoom action");
			}
			runtime?.tabs.zoom(action);
			emitState();
			return getBrowserState();
		}
	);
}

app.whenReady().then(() => {
	const { win, strip, stripView } = createWindow();
	const store = new BrowserStateStore(
		app.getPath("userData"),
		app.getPath("downloads")
	);
	session.defaultSession.setDownloadPath(store.getSettings().downloadDirectory);
	const token = resolveControlToken();
	if (!token) {
		console.warn(
			"[ryu-browser] no RYU_EXT_TOKEN/RYU_BROWSER_TOKEN set — control server is FAIL-CLOSED (all protected routes reject). Core injects RYU_EXT_TOKEN when it spawns this sidecar."
		);
	}
	const tabs = new ElectronTabManager(
		win,
		emitState,
		(tab) => {
			runtime?.store.addHistory(tab.url, tab.title);
		},
		(result) => strip.send("ryu-browser:find-result", result)
	);
	runtime = {
		overlayVisible: false,
		store,
		surface: "browser",
		strip,
		stripView,
		tabs,
		win,
	};
	installPermissionHandlers();
	installDownloadHandlers();
	registerIpcHandlers();
	// Start with one familiar New tab so the browser shell is useful before an agent
	// opens its first page, while the control API still supports an empty session.
	tabs.open("about:blank");
	emitState();
	startControlServer(
		{
			controlEnabled: () => runtime?.store.getSettings().allowControl ?? false,
			tabs,
			token,
		},
		resolveControlPort()
	);
});

app.on("before-quit", () => {
	runtime?.store.flush();
});

app.on("window-all-closed", () => {
	// Keep running headless: Core manages this sidecar's lifecycle (lazy + idle-stop),
	// so closing the window must not kill the control server on non-macOS either.
	// (No-op; do not app.quit().)
});
