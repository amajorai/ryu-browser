// Ryu Browser sidecar — Electron main process.
//
// A real-Chromium browser Core spawns as a `local` manifest sidecar. Each tab is a
// modern `WebContentsView` (Electron ≥30) attached under a native browser shell.
// The loopback control server (`control.ts`) and the shell renderer share the
// same user tab manager; managed cloud Bot calls are routed by the Core-derived
// identity to hidden tab lanes, each in that agent's own persistent Chromium
// partition with its own history, site permissions, and downloads folder.
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
import { SEAL_ENV_VARS } from "@ryu/sidecar-runtime/seal";
import {
	app,
	BaseWindow,
	dialog,
	ipcMain,
	type Session,
	safeStorage,
	session,
	shell,
	type WebContents,
	WebContentsView,
} from "electron";
import { z } from "zod";
import {
	BrowserActivityStore,
	BrowserCaptureMonitor,
	type BrowserTabActivityKind,
} from "./activity.ts";
import type { BrowserAXProtocolValue } from "./ax-records.ts";
import { buildSnapshot, quadCenter, scrollDelta } from "./ax-snapshot.ts";
import {
	botProfilePaths,
	botSessionPartition,
	LEGACY_BOT_PARTITION_CLEARED_MARKER,
	LEGACY_SHARED_BOT_PARTITION,
	LEGACY_SHARED_BOT_STATE_FILE,
} from "./bot-partition.ts";
import { BrowserExtensionManager } from "./browser-extensions.ts";
import {
	browserPermissionSchema,
	browserPersistedCdpSchema,
	browserPersistedProfileSchema,
	browserSurfaceSchema,
} from "./browser-records.ts";
import {
	BROWSER_CHROME_HEIGHT,
	type BrowserDownloadEntry,
	type BrowserDownloadRecord,
	type BrowserHistoryEntry,
	type BrowserPermission,
	type BrowserSettings,
	type BrowserState,
	type BrowserSurface,
	type BrowserTabState,
	cookieImportUrl,
	normalizeBrowserSettings,
	type SitePermission,
	safeDownloadFilename,
} from "./browser-state.ts";
import { createBrowserActivityInitScript } from "./capture-monitor-script.ts";
import type { BrowserCaptureProtocolValue } from "./capture-records.ts";
import {
	type BrowserCDPParameters,
	type BrowserEditableVerdict,
	type BrowserTotpSetupProbe,
	browserCDPAcknowledgementSchema,
	browserCDPAXTreeSchema,
	browserCDPBoxModelSchema,
	browserCDPCredentialProbeSchema,
	browserCDPDecodedQrSchema,
	browserCDPEditableVerdictSchema,
	browserCDPInspectionSchema,
	browserCDPLayoutMetricsSchema,
	browserCDPNodeLocationSchema,
	browserCDPResolvedNodeSchema,
	browserCDPTotpSetupProbeSchema,
} from "./cdp-records.ts";
import {
	resolveControlPort,
	resolveControlToken,
	safeNavigationUrlResolved,
	startControlServer,
} from "./control.ts";
import type { BrowserRawStyleInput } from "./control-records.ts";
import {
	browserCookieExportSchema,
	browserImportedCookieSchema,
} from "./cookie-records.ts";
import {
	type BrowserEvaluationResult,
	browserEvaluationEnvelopeSchema,
} from "./evaluation-records.ts";
import {
	parseUpstreamProxy,
	startGuardedSocksProxy,
} from "./guarded-socks-proxy.ts";
import {
	describeCookieProtection,
	linuxPasswordStore,
	prepareProfileDirectory,
	resolveProfileLocation,
	restrictToOwner,
} from "./profile-storage.ts";
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
	type BrowserWebMCPExecution,
	type BrowserWebMCPTool,
	RefError,
	type ScrollDirection,
	type SnapshotResult,
	type TabInfo,
	type TabManager,
	type TotpSetupSource,
} from "./tab-manager.ts";
import {
	type CredentialField,
	type CredentialTargetProbe,
	performCredentialFill,
	vaultClientFromEnv,
} from "./vault-fill.ts";
import {
	decodeWebMCPResult,
	normalizeWebMCPTools,
	parseWebMCPToolName,
	serializeWebMCPInput,
	WEBMCP_INIT_SCRIPT,
	WebMCPError,
	webMCPExecutionExpression,
} from "./webmcp.ts";
import type { BrowserWebMCPArguments } from "./webmcp-records.ts";

function resolveRemoteCdpEnabled(): boolean {
	const override = process.env.RYU_BROWSER_CDP?.trim();
	if (override) {
		return override === "1";
	}
	try {
		const persisted = JSON.parse(
			readFileSync(join(app.getPath("userData"), "browser-state.json"), "utf8")
		);
		return browserPersistedCdpSchema.safeParse(persisted).success;
	} catch {
		return false;
	}
}

// This app seals nothing itself and does not declare `crypto:seal`, so Core
// delivers it no sealing subkey. Drop any key material anyway (a hand-started
// run may carry `RYU_MASTER_KEY`) so no renderer, utility process or extension
// inherits it.
for (const name of SEAL_ENV_VARS) {
	delete process.env[name];
}

// Before anything reads `userData` (the CDP preflight below) or Chromium opens
// it: keep the profile in this app's plugin data directory, and on Linux ask
// Chromium for a real keyring so encrypted cookies are not keyed by its built-in
// constant (see `profile-storage.ts`).
app.setPath(
	"userData",
	prepareProfileDirectory(
		resolveProfileLocation(process.env, app.getPath("userData"), existsSync)
	)
);
const passwordStore = linuxPasswordStore(process.platform, process.env);
if (passwordStore) {
	app.commandLine.appendSwitch("password-store", passwordStore);
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
const MAX_BOT_BROWSER_SESSIONS = 64;
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
	activityMessageListener?: (
		event: Electron.Event,
		method: string,
		params: BrowserCaptureProtocolValue
	) => void;
	/** Visual notes survive browser-context reads and are cleared on navigation. */
	annotations: BrowserAnnotation[];
	/** Capture observation must be installed before any untrusted navigation. */
	captureReady: Promise<void>;
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

interface InspectedElement extends BrowserElementContext {
	backend_node_id?: number;
}

/** Small, local-only store for browser preferences and non-sensitive metadata. */
class BrowserStateStore {
	private readonly filePath: string;
	private extensionPaths: string[];
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private settings: BrowserSettings;
	private history: BrowserHistoryEntry[];
	private downloads: BrowserDownloadRecord[];

	constructor(userDataPath: string, downloadDirectory: string) {
		mkdirSync(userDataPath, { mode: 0o700, recursive: true });
		restrictToOwner(userDataPath);
		this.filePath = join(userDataPath, "browser-state.json");
		let persisted = browserPersistedProfileSchema.parse({});
		if (existsSync(this.filePath)) {
			try {
				const raw = readFileSync(this.filePath, "utf8");
				persisted = browserPersistedProfileSchema.parse(JSON.parse(raw));
			} catch {
				// A damaged local preference file should restore defaults, never stop the
				// browser from opening.
			}
		}
		this.settings = normalizeBrowserSettings(
			persisted.settings,
			downloadDirectory
		);
		this.extensionPaths = persisted.extensionPaths;
		this.history = persisted.history;
		this.downloads = persisted.downloads;
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

	getDownloads(): BrowserDownloadRecord[] {
		return [...this.downloads];
	}

	getExtensionPaths(): string[] {
		return [...this.extensionPaths];
	}

	addExtensionPath(path: string): void {
		if (!this.extensionPaths.includes(path)) {
			this.extensionPaths = [path, ...this.extensionPaths].slice(0, 24);
			this.persist();
		}
	}

	removeExtensionPath(path: string): void {
		const next = this.extensionPaths.filter((candidate) => candidate !== path);
		if (next.length !== this.extensionPaths.length) {
			this.extensionPaths = next;
			this.persist();
		}
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
		// Debounced: navigations and title updates arrive in bursts, and each
		// immediate write is a synchronous file write on the main process.
		// `before-quit` flushes, so nothing is lost on a clean exit.
		this.schedulePersist();
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
					extensionPaths: this.extensionPaths,
					history: this.history,
					settings: this.settings,
				},
				null,
				2
			);
			// History and download records are private: owner-only.
			writeFileSync(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
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

function finiteCoordinate(value: BrowserAXProtocolValue): number | null {
	const number = Number(value);
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
	style: BrowserStyleAdjust | BrowserRawStyleInput | undefined
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
		const parsedValue = z.string().safeParse(style[key]);
		if (!parsedValue.success) {
			continue;
		}
		const trimmed = parsedValue.data.trim();
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

interface KeyDescriptor {
	code: string;
	key: string;
}

function keyDescriptor(token: string): KeyDescriptor {
	const normalized = token.trim();
	const lower = normalized.toLowerCase();
	const aliases = new Map<string, KeyDescriptor>(
		Object.entries({
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
		})
	);
	const known = aliases.get(lower);
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
		private readonly browserSession: Session,
		private readonly win: BaseWindow,
		private readonly onChange: () => void,
		private readonly onNavigate: (tab: TabInfo) => void,
		private readonly onFindResult: (result: {
			activeMatchOrdinal: number;
			matches: number;
		}) => void,
		private readonly activities?: BrowserActivityStore,
		private readonly activityOwner = "visible"
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
	private async prepareWebMCP(tab: LiveTab): Promise<void> {
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

	private tabActivityInput(tab: LiveTab, kind: BrowserTabActivityKind) {
		const info = this.info(tab);
		return {
			kind,
			selectable: this.activityOwner === "visible",
			tabId: tab.id,
			tabTitle: info.title || "New tab",
			tabUrl: info.url,
		};
	}

	private setTabActivity(
		tab: LiveTab,
		kind: BrowserTabActivityKind,
		active: boolean
	): void {
		this.activities?.setTabActivity(this.tabActivityInput(tab, kind), active);
		this.onChange();
	}

	private updateActivityTab(tab: LiveTab): TabInfo {
		const info = this.info(tab);
		this.activities?.updateTab(tab.id, {
			title: info.title || "New tab",
			url: info.url,
		});
		return info;
	}

	private recordComputerUse(tab: LiveTab): void {
		this.activities?.startComputerUse({
			agentId: this.activityOwner,
			agentLabel: this.activityOwner === "visible" ? "Ryu" : "Ryu agent",
			selectable: false,
			tabId: tab.id,
			tabTitle: this.info(tab).title || "New tab",
		});
	}

	private async mediaStillPlaying(tab: LiveTab): Promise<boolean> {
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

	async eval(id: string, expression: string): Promise<BrowserEvaluationResult> {
		const tab = this.find(id);
		if (!tab) {
			return Promise.reject(new Error("no such tab"));
		}
		// PRIVILEGED: Chromium's own JS evaluation in the tab's isolated web contents.
		// Grant-gated (`browser:control`) + bearer-authed + loopback-only upstream.
		const result = await tab.view.webContents.executeJavaScript(
			expression,
			true
		);
		return browserEvaluationEnvelopeSchema.parse({ result }).result;
	}

	private async inspectWebMCP(tab: LiveTab): Promise<BrowserWebMCPTool[]> {
		const raw = await tab.view.webContents.executeJavaScript(
			"globalThis.__ryuWebMCP?.inspect?.() ?? []",
			true
		);
		return normalizeWebMCPTools(raw);
	}

	async webmcpTools(id: string): Promise<BrowserWebMCPTool[] | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		return this.inspectWebMCP(tab);
	}

	async webmcpExecute(
		id: string,
		name: string,
		input: BrowserWebMCPArguments,
		toolId?: string
	): Promise<BrowserWebMCPExecution | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const toolName = parseWebMCPToolName(name);
		const tools = await this.inspectWebMCP(tab);
		const namedTools = tools.filter((candidate) => candidate.name === toolName);
		const tool = toolId
			? namedTools.find((candidate) => candidate.tool_id === toolId)
			: namedTools.length === 1
				? namedTools[0]
				: null;
		if (!tool) {
			throw new WebMCPError(
				namedTools.length > 1
					? `tool_name '${toolName}' is ambiguous; pass tool_id from the current listing`
					: `no WebMCP tool named '${toolName}'`,
				namedTools.length > 1 ? 400 : 404
			);
		}
		const serializedInput = serializeWebMCPInput(input);
		const rawResult = await tab.view.webContents.executeJavaScript(
			webMCPExecutionExpression(toolName, serializedInput, tool.tool_id),
			true
		);
		return {
			result: decodeWebMCPResult(rawResult),
			tool,
		};
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
	private async cdp<T>(
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
		await this.cdp(tab, "DOM.enable", browserCDPAcknowledgementSchema);
		// "Enables the accessibility domain which causes AXNodeIds to remain
		// consistent between method calls" — we key refs off `backendDOMNodeId`
		// regardless, but the domain must be on for `getFullAXTree`.
		await this.cdp(
			tab,
			"Accessibility.enable",
			browserCDPAcknowledgementSchema
		);
		const { nodes } = await this.cdp(
			tab,
			"Accessibility.getFullAXTree",
			browserCDPAXTreeSchema
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
		let webmcpTools: BrowserWebMCPTool[] = [];
		try {
			webmcpTools = await this.inspectWebMCP(tab);
		} catch {
			// WebMCP is an optional page capability; a page that has navigated while
			// context is being assembled should still yield its regular observation.
		}
		const result: BrowserContextResult = {
			annotations: tab.annotations,
			page: this.info(tab),
			snapshot,
			webmcp_tools: webmcpTools,
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
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "none",
				buttons: 0,
				clickCount: 0,
				type: "mouseMoved",
				x: point.x,
				y: point.y,
			}
		);
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
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "none",
				buttons: 0,
				clickCount: 0,
				type: "mouseMoved",
				x: point.x,
				y: point.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button,
				buttons: 1,
				clickCount: count,
				type: "mousePressed",
				x: point.x,
				y: point.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button,
				buttons: 0,
				clickCount: count,
				type: "mouseReleased",
				x: point.x,
				y: point.y,
			}
		);
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
			await this.cdp(
				tab,
				"Input.dispatchKeyEvent",
				browserCDPAcknowledgementSchema,
				{
					...descriptor,
					type: "keyDown",
				}
			);
		}
		for (const descriptor of [...descriptors].reverse()) {
			await this.cdp(
				tab,
				"Input.dispatchKeyEvent",
				browserCDPAcknowledgementSchema,
				{
					...descriptor,
					type: "keyUp",
				}
			);
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
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "none",
				buttons: 0,
				clickCount: 0,
				type: "mouseMoved",
				x: start.x,
				y: start.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "left",
				buttons: 1,
				clickCount: 1,
				type: "mousePressed",
				x: start.x,
				y: start.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "left",
				buttons: 1,
				clickCount: 1,
				type: "mouseMoved",
				x: end.x,
				y: end.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "left",
				buttons: 0,
				clickCount: 1,
				type: "mouseReleased",
				x: end.x,
				y: end.y,
			}
		);
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
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "none",
				buttons: 0,
				clickCount: 0,
				type: "mouseMoved",
				x: point.x,
				y: point.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "left",
				buttons: 1,
				clickCount: 1,
				type: "mousePressed",
				x: point.x,
				y: point.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "left",
				buttons: 0,
				clickCount: 1,
				type: "mouseReleased",
				x: point.x,
				y: point.y,
			}
		);
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
		await this.cdp(tab, "DOM.enable", browserCDPAcknowledgementSchema);
		await this.scrollIntoView(tab, backendNodeId);
		try {
			await this.cdp(tab, "DOM.focus", browserCDPAcknowledgementSchema, {
				backendNodeId,
			});
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
				await this.cdp(
					tab,
					"Input.dispatchKeyEvent",
					browserCDPAcknowledgementSchema,
					{
						...DELETE_KEY,
						type: "keyDown",
					}
				);
				await this.cdp(
					tab,
					"Input.dispatchKeyEvent",
					browserCDPAcknowledgementSchema,
					{
						...DELETE_KEY,
						type: "keyUp",
					}
				);
			}
		}
		if (text.length > 0) {
			// `Input.insertText` "emulates inserting text that doesn't come from a key
			// press": it goes through the editing pipeline (so React-controlled inputs
			// see a real `input` event) but fires no `keydown`. It inserts at the caret,
			// replacing whatever is selected — which is why `replace` above works by
			// selecting first rather than by clearing separately.
			await this.cdp(tab, "Input.insertText", browserCDPAcknowledgementSchema, {
				text,
			});
		}
		if (submit) {
			await this.pressEnter(tab);
		}
		return { ok: true, tab: this.info(tab) };
	}

	/**
	 * The one keystroke `submit` needs as a real key event — forms and search
	 * boxes listen for `keydown`, which `insertText` does not produce.
	 */
	private async pressEnter(tab: LiveTab): Promise<void> {
		await this.cdp(
			tab,
			"Input.dispatchKeyEvent",
			browserCDPAcknowledgementSchema,
			{
				...ENTER_KEY,
				text: "\r",
				type: "keyDown",
				unmodifiedText: "\r",
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchKeyEvent",
			browserCDPAcknowledgementSchema,
			{
				...ENTER_KEY,
				type: "keyUp",
			}
		);
	}

	/** A Runtime remote object for a snapshot ref, for `callFunctionOn`. */
	private async resolveObject(
		tab: LiveTab,
		backendNodeId: number,
		ref: string
	): Promise<string> {
		let objectId: string | undefined;
		try {
			const resolved = await this.cdp(
				tab,
				"DOM.resolveNode",
				browserCDPResolvedNodeSchema,
				{ backendNodeId }
			);
			objectId = resolved.object?.objectId;
		} catch {
			objectId = undefined;
		}
		if (!objectId) {
			throw new RefError(
				`element '${ref}' is gone from the page; snapshot again`
			);
		}
		return objectId;
	}

	private async releaseObject(tab: LiveTab, objectId: string): Promise<void> {
		try {
			await this.cdp(
				tab,
				"Runtime.releaseObject",
				browserCDPAcknowledgementSchema,
				{
					objectId,
				}
			);
		} catch {
			// The page may have navigated; its objects are gone with it.
		}
	}

	/**
	 * Report what holds focus relative to the referenced element. Runs ON the
	 * referenced node (`callFunctionOn`), so `window` is that node's own frame:
	 * a node inside any child frame reports `in_frame` even when it is
	 * same-origin, and a top-level focus that sits on an <iframe> (focus delegated
	 * into a cross-origin frame) reports it too. Unlike `assertCanAcceptText`
	 * this fails CLOSED: anything unexpected becomes a refusal.
	 */
	private async probeCredentialTarget(
		tab: LiveTab,
		objectId: string
	): Promise<CredentialTargetProbe> {
		const functionDeclaration = `function () {
			const inChildFrame = window !== window.top;
			let el = document.activeElement;
			while (el && el.shadowRoot && el.shadowRoot.activeElement) {
				el = el.shadowRoot.activeElement;
			}
			if (!el || el === document.body) {
				return { in_frame: inChildFrame, focused: false, tag: "", editable: false };
			}
			const target = this;
			const focused = el === target ||
				(typeof target.contains === "function" && target.contains(el)) ||
				(target.shadowRoot ? target.shadowRoot.contains(el) : false) ||
				target.control === el;
			const tag = String(el.tagName || "").toUpperCase();
			return {
				in_frame: inChildFrame || tag === "IFRAME" || tag === "FRAME",
				focused: focused === true,
				tag,
				input_type: tag === "INPUT" ? String(el.type || "text").toLowerCase() : undefined,
				editable: el.isContentEditable === true || tag === "INPUT" || tag === "TEXTAREA",
				disabled: el.disabled === true,
				read_only: el.readOnly === true,
			};
		}`;
		const fallback: CredentialTargetProbe = {
			editable: false,
			focused: false,
			in_frame: true,
			tag: "",
		};
		try {
			const res = await this.cdp(
				tab,
				"Runtime.callFunctionOn",
				browserCDPCredentialProbeSchema,
				{ functionDeclaration, objectId, returnByValue: true }
			);
			return res.result?.value ?? fallback;
		} catch {
			return fallback;
		}
	}

	async fillCredential(
		id: string,
		ref: string,
		field: CredentialField,
		resolveValue: (pageUrl: string) => Promise<string>,
		submit: boolean
	): Promise<ActionResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const backendNodeId = ElectronTabManager.resolveRef(tab, ref);
		await this.cdp(tab, "DOM.enable", browserCDPAcknowledgementSchema);
		await this.scrollIntoView(tab, backendNodeId);
		try {
			await this.cdp(tab, "DOM.focus", browserCDPAcknowledgementSchema, {
				backendNodeId,
			});
		} catch (e) {
			throw new RefError(
				`element '${ref}' cannot take keyboard focus (${e instanceof Error ? e.message : String(e)})`
			);
		}
		const objectId = await this.resolveObject(tab, backendNodeId, ref);
		try {
			await performCredentialFill(
				{
					insert: async (value) => {
						// Replace, never append: a half-typed or browser-autofilled value
						// in front of the secret would make the credential wrong.
						await this.selectAllInFocused(tab);
						await this.cdp(
							tab,
							"Input.insertText",
							browserCDPAcknowledgementSchema,
							{
								text: value,
							}
						);
					},
					pageUrl: () => tab.view.webContents.getURL(),
					probe: () => this.probeCredentialTarget(tab, objectId),
				},
				field,
				resolveValue
			);
		} finally {
			await this.releaseObject(tab, objectId);
		}
		if (submit) {
			await this.pressEnter(tab);
		}
		return { ok: true, tab: this.info(tab) };
	}

	async readTotpSetup(
		id: string,
		ref: string
	): Promise<TotpSetupSource | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const backendNodeId = ElectronTabManager.resolveRef(tab, ref);
		await this.cdp(tab, "DOM.enable", browserCDPAcknowledgementSchema);
		await this.scrollIntoView(tab, backendNodeId);
		const objectId = await this.resolveObject(tab, backendNodeId, ref);
		try {
			const probe = await this.probeTotpSetup(tab, objectId);
			const candidates: string[] = [];
			let qr = probe.qr ?? null;
			if (!qr && probe.detector && probe.media) {
				// The direct decode fails for a cross-origin <img> (a tainted source).
				// The pixels on screen are not tainted, so decode a capture instead.
				qr = await this.decodeQrFromCapture(tab, objectId, probe.media);
			}
			if (qr) {
				candidates.push(qr);
			}
			candidates.push(...(probe.text ?? []));
			return { candidates, in_frame: probe.in_frame, tab: this.info(tab) };
		} finally {
			await this.releaseObject(tab, objectId);
		}
	}

	/**
	 * Read TOTP setup material from (and under) the referenced element: a QR code
	 * decoded with Chromium's `BarcodeDetector` when the element is or contains an
	 * <img>/<canvas>/<svg>/<video>, plus its value/text and any `otpauth:` link.
	 * `BarcodeDetector` is not available on every platform; the text path is the
	 * fallback ("can't scan?" setup keys).
	 */
	private async probeTotpSetup(
		tab: LiveTab,
		objectId: string
	): Promise<BrowserTotpSetupProbe> {
		const functionDeclaration = `async function () {
			const root = this;
			const out = { in_frame: window !== window.top, qr: null, media: null, detector: typeof BarcodeDetector === "function", text: [] };
			const mediaTags = ["img", "canvas", "svg", "video"];
			const isMedia = (n) => !!n && typeof n.tagName === "string" && mediaTags.includes(n.tagName.toLowerCase());
			const media = isMedia(root) ? root : (typeof root.querySelector === "function" ? root.querySelector("img, canvas, svg, video") : null);
			if (media) {
				const r = media.getBoundingClientRect();
				out.media = { x: r.x, y: r.y, width: r.width, height: r.height };
			}
			if (media && out.detector) {
				try {
					let source = media;
					if (media.tagName.toLowerCase() === "svg") {
						const xml = new XMLSerializer().serializeToString(media);
						const img = new Image();
						img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
						await img.decode();
						source = img;
					}
					const codes = await new BarcodeDetector({ formats: ["qr_code"] }).detect(source);
					if (codes.length > 0) out.qr = String(codes[0].rawValue || "") || null;
				} catch (e) {}
			}
			const push = (v) => {
				if (typeof v === "string" && v.trim() && out.text.length < 16) out.text.push(v.trim().slice(0, 4096));
			};
			push(root.value);
			push(root.innerText);
			push(root.textContent);
			push(root.getAttribute && root.getAttribute("href"));
			if (typeof root.querySelectorAll === "function") {
				for (const a of root.querySelectorAll("a[href^='otpauth:'], input, textarea, code")) {
					push(a.getAttribute("href"));
					push(a.value);
					push(a.textContent);
				}
			}
			return out;
		}`;
		try {
			const res = await this.cdp(
				tab,
				"Runtime.callFunctionOn",
				browserCDPTotpSetupProbeSchema,
				{
					awaitPromise: true,
					functionDeclaration,
					objectId,
					returnByValue: true,
				}
			);
			return res.result?.value ?? { in_frame: false, text: [] };
		} catch {
			return { in_frame: false, text: [] };
		}
	}

	/** Decode a QR code from a capture of the element's on-screen box. */
	private async decodeQrFromCapture(
		tab: LiveTab,
		objectId: string,
		rect: BrowserRect
	): Promise<string | null> {
		if (rect.width < 1 || rect.height < 1) {
			return null;
		}
		const zoom = tab.view.webContents.getZoomFactor();
		let png: string;
		try {
			const image = await tab.view.webContents.capturePage({
				height: Math.ceil(rect.height * zoom),
				width: Math.ceil(rect.width * zoom),
				x: Math.max(0, Math.floor(rect.x * zoom)),
				y: Math.max(0, Math.floor(rect.y * zoom)),
			});
			png = image.toPNG().toString("base64");
		} catch {
			return null;
		}
		const functionDeclaration = `async function (png) {
			try {
				const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
				const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
				const codes = await new BarcodeDetector({ formats: ["qr_code"] }).detect(bitmap);
				return codes.length > 0 ? String(codes[0].rawValue || "") || null : null;
			} catch (e) {
				return null;
			}
		}`;
		try {
			const res = await this.cdp(
				tab,
				"Runtime.callFunctionOn",
				browserCDPDecodedQrSchema,
				{
					arguments: [{ value: png }],
					awaitPromise: true,
					functionDeclaration,
					objectId,
					returnByValue: true,
				}
			);
			return res.result?.value ?? null;
		} catch {
			return null;
		}
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
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "none",
				buttons: 0,
				deltaX,
				deltaY,
				type: "mouseWheel",
				x,
				y,
			}
		);
		return { ok: true, tab: this.info(tab), x, y };
	}

	private async inspectSelections(
		tab: LiveTab,
		selections: BrowserRect[]
	): Promise<BrowserElementContext[]> {
		if (selections.length === 0) {
			return [];
		}
		await this.cdp(tab, "DOM.enable", browserCDPAcknowledgementSchema);
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
			location = await this.cdp(
				tab,
				"DOM.getNodeForLocation",
				browserCDPNodeLocationSchema,
				{
					includeUserAgentShadowDOM: true,
					x,
					y,
				}
			);
		} catch {
			return null;
		}
		if (location.backendNodeId === undefined) {
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
			const evaluated = await this.cdp(
				tab,
				"Runtime.evaluate",
				browserCDPInspectionSchema,
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
			const metrics = await this.cdp(
				tab,
				"Page.getLayoutMetrics",
				browserCDPLayoutMetricsSchema
			);
			const vp = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
			if (
				vp?.clientWidth !== undefined &&
				vp.clientHeight !== undefined &&
				vp.clientWidth > 0 &&
				vp.clientHeight > 0
			) {
				return {
					height: vp.clientHeight,
					scroll_x: vp.pageX ?? 0,
					scroll_y: vp.pageY ?? 0,
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
		let verdict: BrowserEditableVerdict | undefined;
		try {
			const res = await this.cdp(
				tab,
				"Runtime.evaluate",
				browserCDPEditableVerdictSchema,
				{ expression, returnByValue: true }
			);
			verdict = res?.result?.value;
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
		await this.cdp(tab, "Runtime.evaluate", browserCDPAcknowledgementSchema, {
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
			await this.cdp(
				tab,
				"DOM.scrollIntoViewIfNeeded",
				browserCDPAcknowledgementSchema,
				{ backendNodeId }
			);
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
		await this.cdp(tab, "DOM.enable", browserCDPAcknowledgementSchema);
		await this.scrollIntoView(tab, backendNodeId);
		let model: { content?: BrowserAXProtocolValue } | undefined;
		try {
			const box = await this.cdp(
				tab,
				"DOM.getBoxModel",
				browserCDPBoxModelSchema,
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

interface BrowserBotProfile {
	readonly store: BrowserStateStore;
	readonly tabs: ElectronTabManager;
	readonly win: BaseWindow;
}

/**
 * Routes Core-derived agent browser calls into managed-Bot Chromium contexts.
 * Each Bot gets a separate hidden native window, tab manager, persistent
 * Chromium partition (`persist:ryu-bot-<agent>`), and state store
 * (`managed-bots/agents/ryu-bot-<agent>/`), so one agent never sees the
 * cookies, logins, site storage, browsing history, saved site permissions, or
 * downloads of another agent. The visible user's browser shell remains a
 * separate session with its own store.
 */
export class BrowserSessionRouter {
	private readonly profiles = new Map<string, BrowserBotProfile>();
	private readonly pendingProfiles = new Map<
		string,
		Promise<TabManager | null>
	>();
	private readonly sessions = new Map<string, Promise<Session>>();
	private readonly stores = new Map<string, BrowserStateStore>();
	private readonly root: string;
	private closed = false;

	constructor(
		private readonly activities: BrowserActivityStore,
		private readonly onActivityChange: () => void,
		private readonly guardNetwork: (browserSession: Session) => Promise<void>
	) {
		const root = join(app.getPath("userData"), "managed-bots");
		this.root = root;
		this.removeLegacySharedState(root);
		this.clearLegacySharedSession(root).catch((error: unknown) => {
			console.error(
				"[ryu-browser] could not clear the legacy shared Bot session",
				error
			);
		});
	}

	/**
	 * Every Bot used to share one Chromium partition. Each agent now signs in
	 * in its own, so the shared jar's cookies and site storage are orphaned
	 * sign-ins: clear them once rather than leave them on disk. Agents sign in
	 * again in their own profiles.
	 */
	private async clearLegacySharedSession(root: string): Promise<void> {
		const marker = join(root, LEGACY_BOT_PARTITION_CLEARED_MARKER);
		if (existsSync(marker)) {
			return;
		}
		const legacy = session.fromPartition(LEGACY_SHARED_BOT_PARTITION);
		await legacy.clearStorageData();
		await legacy.clearCache();
		mkdirSync(root, { recursive: true });
		writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
	}

	/**
	 * Every Bot used to share one history, site-permission list, and download
	 * list. Those entries cannot be attributed to an agent, so they are deleted
	 * rather than handed to whichever agent opens first. Files already saved in
	 * the old shared downloads folder are left where they are.
	 */
	private removeLegacySharedState(root: string): void {
		const legacyState = join(root, LEGACY_SHARED_BOT_STATE_FILE);
		if (!existsSync(legacyState)) {
			return;
		}
		try {
			unlinkSync(legacyState);
		} catch (error) {
			console.error(
				"[ryu-browser] could not remove the legacy shared Bot state",
				error
			);
		}
	}

	/** One agent's own history, site permissions, and downloads folder. */
	private storeFor(key: string): BrowserStateStore {
		const existing = this.stores.get(key);
		if (existing) {
			return existing;
		}
		const paths = botProfilePaths(this.root, key);
		mkdirSync(paths.downloadDirectory, { recursive: true });
		const created = new BrowserStateStore(
			paths.stateDirectory,
			paths.downloadDirectory
		);
		this.stores.set(key, created);
		return created;
	}

	tabsFor(agentId: string): TabManager | null | Promise<TabManager | null> {
		const key = normalizeBrowserAgentId(agentId);
		if (!key || this.closed) {
			return null;
		}
		const existing = this.profiles.get(key);
		if (existing) {
			return existing.tabs;
		}
		const pending = this.pendingProfiles.get(key);
		if (pending) {
			return pending;
		}
		if (
			this.profiles.size + this.pendingProfiles.size >=
			MAX_BOT_BROWSER_SESSIONS
		) {
			return null;
		}
		const created = this.createProfile(key).finally(() =>
			this.pendingProfiles.delete(key)
		);
		this.pendingProfiles.set(key, created);
		return created;
	}

	private async createProfile(key: string): Promise<TabManager | null> {
		let botSession: Session;
		let store: BrowserStateStore;
		try {
			store = this.storeFor(key);
			botSession = await this.ensureBotSession(botSessionPartition(key), store);
		} catch (error) {
			console.error(
				"[ryu-browser] Bot profile or network guard could not be prepared",
				error
			);
			return null;
		}
		if (this.closed) {
			return null;
		}
		const win = new BaseWindow({
			height: FALLBACK_VIEWPORT.height,
			show: false,
			title: "Ryu Browser Bot session",
			width: FALLBACK_VIEWPORT.width,
		});
		const tabs = new ElectronTabManager(
			botSession,
			win,
			this.onActivityChange,
			(tab) => store.addHistory(tab.url, tab.title),
			() => undefined,
			this.activities,
			key
		);
		this.profiles.set(key, { store, tabs, win });
		return tabs;
	}

	/**
	 * Configure one agent's partition exactly once: the guarded network proxy
	 * (fail closed before any page can load), navigation re-screening, the
	 * agent's own download folder, and the non-interactive permission and
	 * download handlers bound to that agent's own store.
	 */
	private ensureBotSession(
		partition: string,
		store: BrowserStateStore
	): Promise<Session> {
		const cached = this.sessions.get(partition);
		if (cached) {
			return cached;
		}
		const configured = this.configureBotSession(partition, store);
		this.sessions.set(partition, configured);
		configured.catch(() => this.sessions.delete(partition));
		return configured;
	}

	private async configureBotSession(
		partition: string,
		store: BrowserStateStore
	): Promise<Session> {
		const botSession = session.fromPartition(partition);
		await this.guardNetwork(botSession);
		installNavigationGuard(botSession);
		botSession.setDownloadPath(store.getSettings().downloadDirectory);
		installPermissionHandlers(botSession, store, null, false);
		installDownloadHandlers(botSession, store, null, false, () => undefined);
		return botSession;
	}

	flush(): void {
		for (const store of this.stores.values()) {
			store.flush();
		}
	}

	closeAll(): void {
		this.closed = true;
		this.flush();
		for (const profile of this.profiles.values()) {
			profile.win.destroy();
		}
		this.profiles.clear();
	}
}

/** Every loopback spelling a page could use to reach a local service. */
const NETWORK_GUARD_PROBES = [
	"http://127.0.0.1/",
	"http://localhost/",
	"http://[::1]/",
];

/**
 * Send every request from a Chromium session through the guarded SOCKS proxy,
 * and fail closed when Chromium does not report the proxy as effective.
 */
async function routeThroughNetworkGuard(
	browserSession: Session,
	port: number
): Promise<void> {
	await browserSession.setProxy({
		mode: "fixed_servers",
		proxyRules: `socks5://127.0.0.1:${port}`,
		proxyBypassRules: "<-loopback>",
	});
	// Since Electron 45, `setProxy` can resolve before Chromium applies the new
	// config, so the first lookup in a fresh process still answers DIRECT. Reload
	// it so the guard is in effect before any check or page load.
	await browserSession.forceReloadProxyConfig();
	for (const probe of NETWORK_GUARD_PROBES) {
		const effective = await browserSession.resolveProxy(probe);
		if (effective !== `SOCKS5 127.0.0.1:${port}`) {
			throw new Error("browser network guard is not active");
		}
	}
}

/** Re-screen every Chromium main-frame navigation, including redirect hops. */
function installNavigationGuard(browserSession: Session): void {
	browserSession.webRequest.onBeforeRequest(
		{ urls: ["http://*/*", "https://*/*"] },
		(details, callback) => {
			if (
				details.resourceType !== "mainFrame" &&
				details.resourceType !== "subFrame"
			) {
				callback({ cancel: false });
				return;
			}
			void safeNavigationUrlResolved(details.url)
				.then(() => callback({ cancel: false }))
				.catch(() => callback({ cancel: true }));
		}
	);
}

function normalizeBrowserAgentId(value: string): string | null {
	const trimmed = value.trim();
	if (
		trimmed.length === 0 ||
		trimmed.length > 128 ||
		[...trimmed].some((char) => /\p{Cc}/u.test(char))
	) {
		return null;
	}
	return trimmed;
}

interface BrowserRuntime {
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

let runtime: BrowserRuntime | null = null;
let botSessions: BrowserSessionRouter | null = null;

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

interface CreateWindowResult {
	strip: WebContents;
	stripView: WebContentsView;
	win: BaseWindow;
}

function createWindow(): CreateWindowResult {
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
	runtime.strip.send("ryu-browser:theme", runtime.themeTokens);
	runtime.strip.send("ryu-browser:state", getBrowserState());
}

function setThemeTokens(tokens: Record<string, string>): void {
	if (!runtime) {
		return;
	}
	runtime.themeTokens = { ...tokens };
	runtime.strip.send("ryu-browser:theme", runtime.themeTokens);
}

function getBrowserState(): BrowserState {
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

async function normalizedNavigationUrl(value: string): Promise<string> {
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

function updateSetting(
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

type BrowserNativePermissionDetails =
	| Parameters<
			NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>
	  >[3]
	| Parameters<
			NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>
	  >[3];

function permissionOrigin(
	contents: WebContents,
	details: BrowserNativePermissionDetails
): string | null {
	const parsedURL = z.string().safeParse(details.requestingUrl);
	const raw = parsedURL.success ? parsedURL.data : contents.getURL();
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
	details: BrowserNativePermissionDetails
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
	const requestedTypes =
		"mediaTypes" in details ? details.mediaTypes : undefined;
	const mediaTypes = Array.isArray(requestedTypes)
		? requestedTypes
		: ["mediaType" in details ? details.mediaType : undefined];
	const keys: BrowserPermission[] = [];
	if (mediaTypes.includes("video")) {
		keys.push("camera");
	}
	if (mediaTypes.includes("audio")) {
		keys.push("microphone");
	}
	return keys.length > 0 ? keys : ["camera", "microphone"];
}

function installPermissionHandlers(
	browserSession: Session,
	store: BrowserStateStore,
	win: BaseWindow | null,
	allowPrompts: boolean
): void {
	browserSession.setPermissionCheckHandler(
		(_contents, permission, origin, details) => {
			const keys = permissionKeys(permission, details);
			if (keys.length === 0) {
				return false;
			}
			return keys.every((key) => {
				const explicit = store.permissionFor(origin, key);
				return (
					explicit === "allow" ||
					(allowPrompts &&
						explicit === null &&
						store.getSettings().approval === "always-allow")
				);
			});
		}
	);
	browserSession.setPermissionRequestHandler(
		async (contents, permission, callback, details) => {
			const origin = permissionOrigin(contents, details);
			const keys = permissionKeys(permission, details);
			if (!(origin && keys.length > 0)) {
				callback(false);
				return;
			}
			const decisions = keys.map((key) => store.permissionFor(origin, key));
			if (decisions.includes("deny")) {
				callback(false);
				return;
			}
			if (decisions.every((decision) => decision === "allow")) {
				callback(true);
				return;
			}
			if (allowPrompts && store.getSettings().approval === "always-allow") {
				callback(true);
				return;
			}
			if (!(allowPrompts && win)) {
				callback(false);
				return;
			}
			const result = await dialog.showMessageBox(win, {
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

function installDownloadHandlers(
	browserSession: Session,
	store: BrowserStateStore,
	win: BaseWindow | null,
	interactive: boolean,
	onChange: () => void
): void {
	browserSession.on("will-download", (_event, item, _webContents) => {
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
		store.upsertDownload(initial);
		onChange();

		const persistDownload = (state: BrowserDownloadEntry["state"]): void => {
			const totalBytes = item.getTotalBytes();
			const receivedBytes = item.getReceivedBytes();
			store.upsertDownload(
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
			onChange();
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

		const settings = store.getSettings();
		const defaultPath = join(settings.downloadDirectory, filename);
		if (!(interactive && win && settings.askWhereToSave)) {
			item.setSavePath(defaultPath);
			return;
		}
		dialog
			.showSaveDialog(win, {
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
		const parsedExport = browserCookieExportSchema.safeParse(
			JSON.parse(readFileSync(selected.filePaths[0], "utf8"))
		);
		const list = parsedExport.success
			? Array.isArray(parsedExport.data)
				? parsedExport.data
				: parsedExport.data.cookies
			: [];
		let imported = 0;
		for (const value of list.slice(0, 500)) {
			const parsedCookie = browserImportedCookieSchema.safeParse(value);
			if (!parsedCookie.success) {
				continue;
			}
			const cookie = parsedCookie.data;
			const name = cookie.name;
			const cookieValue = cookie.value;
			const domain = cookie.domain;
			const path = cookie.path;
			const url = cookieImportUrl(cookie.url, domain, path);
			if (!(name && url && /^https?:\/\//i.test(url))) {
				continue;
			}
			await session.defaultSession.cookies.set({
				domain: domain || undefined,
				expirationDate: cookie.expirationDate,
				httpOnly: cookie.httpOnly === true,
				name,
				path,
				sameSite: cookie.sameSite,
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
		(_event, input: SitePermission) => {
			const parsedInput = z
				.object({
					origin: z.string(),
					permission: browserPermissionSchema,
					decision: z.enum(["allow", "deny"]),
				})
				.safeParse(input);
			if (!parsedInput.success) {
				throw new Error("Invalid site permission");
			}
			const candidate = parsedInput.data;
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
	ipcMain.handle("ryu-browser:get-theme", () => ({ ...runtime?.themeTokens }));
	ipcMain.handle("ryu-browser:import-cookies", () => importCookies());
	ipcMain.handle("ryu-browser:choose-extension-directory", async () => {
		if (!runtime) {
			return null;
		}
		const result = await dialog.showOpenDialog(runtime.win, {
			properties: ["openDirectory"],
			title: "Load unpacked Chromium extension",
		});
		const path = result.filePaths[0];
		if (result.canceled || !path) {
			return null;
		}
		await runtime.extensions.load(path);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:list", () => runtime?.tabs.list() ?? []);
	ipcMain.handle("ryu-browser:navigate", async (_event, value: string) => {
		const url = await normalizedNavigationUrl(value);
		const id = runtime?.tabs.activeId();
		if (id) {
			runtime?.tabs.navigate(id, url);
		} else {
			runtime?.tabs.open(url);
		}
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:open", async (_event, value?: string) => {
		const url = value ? await normalizedNavigationUrl(value) : "about:blank";
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
		(_event, origin: string, permission: BrowserPermission) => {
			const parsedPermission = browserPermissionSchema.safeParse(permission);
			if (!(runtime && parsedPermission.success)) {
				throw new Error("Invalid site permission");
			}
			runtime.store.removeSitePermission(origin, parsedPermission.data);
			emitState();
			return getBrowserState();
		}
	);
	ipcMain.handle("ryu-browser:remove-extension", (_event, id: string) => {
		const parsedId = z.string().safeParse(id);
		if (
			!(runtime && parsedId.success && runtime.extensions.remove(parsedId.data))
		) {
			throw new Error("No such browser extension");
		}
		emitState();
		return getBrowserState();
	});
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
		(_event, visible: boolean) => {
			const parsedVisible = z.boolean().safeParse(visible);
			if (!(runtime && parsedVisible.success)) {
				throw new Error("Invalid browser overlay state");
			}
			runtime.overlayVisible = parsedVisible.data;
			layoutShell();
		}
	);
	ipcMain.handle("ryu-browser:set-cdp-enabled", (_event, enabled: boolean) => {
		const parsedEnabled = z.boolean().safeParse(enabled);
		if (!(runtime && parsedEnabled.success)) {
			throw new Error("Invalid CDP setting");
		}
		runtime.store.setSetting("developerCdp", parsedEnabled.data);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle(
		"ryu-browser:set-setting",
		(
			_event,
			key: keyof BrowserSettings,
			value: BrowserSettings[keyof BrowserSettings]
		) => {
			updateSetting(key, value);
			emitState();
			return getBrowserState();
		}
	);
	ipcMain.handle(
		"ryu-browser:set-surface",
		(_event, surface: BrowserSurface) => {
			const parsedSurface = browserSurfaceSchema.safeParse(surface);
			if (!parsedSurface.success) {
				throw new Error("Invalid browser surface");
			}
			setChromeSurface(parsedSurface.data);
			return getBrowserState();
		}
	);
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

let closeNetworkGuard: (() => void) | null = null;

app
	.whenReady()
	.then(async () => {
		// On a cloud node Core hands us its credentialed proxy so tabs follow
		// "Route traffic through this computer"; a malformed value fails closed.
		const networkGuard = await startGuardedSocksProxy({
			upstream: parseUpstreamProxy(process.env.RYU_EGRESS_PROXY_URL),
		});
		closeNetworkGuard = networkGuard.close;
		const guardNetwork = (browserSession: Session): Promise<void> =>
			routeThroughNetworkGuard(browserSession, networkGuard.port);
		await guardNetwork(session.defaultSession);
		const cookieProtection = describeCookieProtection(
			process.platform,
			process.platform === "linux"
				? safeStorage.getSelectedStorageBackend()
				: null,
			safeStorage.isEncryptionAvailable()
		);
		if (!cookieProtection.protected) {
			console.warn(
				`[ryu-browser] cookies are not encrypted with an OS key: ${cookieProtection.detail}`
			);
		}
		const { win, strip, stripView } = createWindow();
		const store = new BrowserStateStore(
			app.getPath("userData"),
			app.getPath("downloads")
		);
		const activities = new BrowserActivityStore(() => {
			if (runtime) {
				emitState();
			}
		});
		const extensions = new BrowserExtensionManager(
			session.defaultSession,
			store
		);
		await extensions.restore();
		botSessions = new BrowserSessionRouter(
			activities,
			() => {
				if (runtime) {
					emitState();
				}
			},
			guardNetwork
		);
		session.defaultSession.setDownloadPath(
			store.getSettings().downloadDirectory
		);
		const token = resolveControlToken();
		if (!token) {
			console.warn(
				"[ryu-browser] no RYU_EXT_TOKEN/RYU_BROWSER_TOKEN set — control server is FAIL-CLOSED (all protected routes reject). Core injects RYU_EXT_TOKEN when it spawns this sidecar."
			);
		}
		const tabs = new ElectronTabManager(
			session.defaultSession,
			win,
			emitState,
			(tab) => {
				runtime?.store.addHistory(tab.url, tab.title);
			},
			(result) => strip.send("ryu-browser:find-result", result),
			activities,
			"visible"
		);
		installNavigationGuard(session.defaultSession);
		runtime = {
			activities,
			overlayVisible: false,
			extensions,
			store,
			surface: "browser",
			strip,
			stripView,
			themeTokens: {},
			tabs,
			win,
		};
		installPermissionHandlers(session.defaultSession, store, win, true);
		installDownloadHandlers(
			session.defaultSession,
			store,
			win,
			true,
			emitState
		);
		registerIpcHandlers();
		// Start with one familiar New tab so the browser shell is useful before an agent
		// opens its first page, while the control API still supports an empty session.
		tabs.open("about:blank");
		emitState();
		startControlServer(
			{
				controlEnabled: () =>
					runtime?.store.getSettings().allowControl ?? false,
				setTheme: setThemeTokens,
				tabs,
				tabsFor: (agentId) => botSessions?.tabsFor(agentId) ?? null,
				token,
				validateNavigationUrl: safeNavigationUrlResolved,
				vault: vaultClientFromEnv(),
			},
			resolveControlPort()
		);
	})
	.catch((error) => {
		console.error("[ryu-browser] network guard initialization failed", error);
		app.quit();
	});

app.on("before-quit", () => {
	closeNetworkGuard?.();
	runtime?.store.flush();
	botSessions?.closeAll();
	botSessions = null;
});

app.on("window-all-closed", () => {
	// Keep running headless: Core manages this sidecar's lifecycle (lazy + idle-stop),
	// so closing the window must not kill the control server on non-macOS either.
	// (No-op; do not app.quit().)
});
