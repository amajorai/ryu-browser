import {
	existsSync,
	mkdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app, BaseWindow, type Session, session } from "electron";
import type { BrowserActivityStore } from "./activity.ts";
import type { LiveViewSource } from "./bot-live-view.ts";
import {
	botProfilePaths,
	botSessionPartition,
	LEGACY_BOT_PARTITION_CLEARED_MARKER,
	LEGACY_SHARED_BOT_PARTITION,
	LEGACY_SHARED_BOT_STATE_FILE,
} from "./bot-partition.ts";
import {
	botProfilesRoot,
	type ChromiumCookie,
	emptyStore,
	isBotProfileId,
	profileIdFor,
} from "./bot-profiles.ts";
import {
	installDownloadHandlers,
	installPermissionHandlers,
} from "./browser-handlers.ts";
import { BrowserStateStore } from "./browser-state-store.ts";
import { pinWebRtcToProxy } from "./chromium-egress-hardening.ts";
import {
	LaneEgressPolicies,
	parseEgressAllowlist,
} from "./egress-allowlist.ts";
import { ElectronTabManager } from "./electron-tab-manager.ts";
import type { DestinationFilter } from "./guarded-socks-proxy.ts";
import { safeNavigationUrlResolved } from "./navigation-safety.ts";
import type { TabInfo, TabManager } from "./tab-manager.ts";
import { FALLBACK_VIEWPORT } from "./tab-support.ts";

export const MAX_BOT_BROWSER_SESSIONS = 64;

/** How a Bot lane reaches the network: its own guarded proxy, nothing else. */
export interface BotLaneNetwork {
	/** Throws while Chromium runs with a setting that bypasses session proxies. */
	assertNoBypass(): void;
	/** Point a Chromium session at a proxy port; throws when it does not take effect. */
	route(browserSession: Session, port: number): Promise<void>;
	/** Start a guarded proxy that refuses every destination `allows` rejects. */
	startProxy(
		allows: DestinationFilter
	): Promise<{ close: () => void; port: number }>;
}

export interface BrowserBotProfile {
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
 *
 * Each Bot partition also gets its own guarded SOCKS proxy. When Core hands a
 * lane an egress allowlist (`egress-allowlist.ts`), that proxy and the lane's
 * request filter refuse every other host; WebRTC in the lane's tabs is pinned
 * to proxied traffic, and lanes stay closed while Chromium runs with a
 * proxy-bypassing setting (`chromium-egress-hardening.ts`).
 */
export class BrowserSessionRouter {
	private readonly profiles = new Map<string, BrowserBotProfile>();
	private readonly pendingProfiles = new Map<
		string,
		Promise<TabManager | null>
	>();
	private readonly sessions = new Map<string, Promise<Session>>();
	private readonly proxies = new Map<string, () => void>();
	private readonly egress = new LaneEgressPolicies();
	private readonly stores = new Map<string, BrowserStateStore>();
	/** Profile ids mid-delete: no lane may reopen on them until it finishes. */
	private readonly deleting = new Set<string>();
	private readonly root: string;
	private closed = false;

	constructor(
		private readonly activities: BrowserActivityStore,
		private readonly onActivityChange: () => void,
		private readonly network: BotLaneNetwork
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

	/**
	 * The agent's own tab lane, created on first use. `egressAllowlist` is the
	 * raw allowlist header Core sent with this verified agent-lane request; it
	 * is pinned to the lane before the lane is created, and a malformed or
	 * widening allowlist throws `EgressAllowlistError`.
	 */
	tabsFor(
		agentId: string,
		egressAllowlist?: string
	): TabManager | null | Promise<TabManager | null> {
		const key = normalizeBrowserAgentId(agentId);
		if (!key || this.closed || this.deleting.has(profileIdFor(key))) {
			return null;
		}
		this.egress.admit(key, parseEgressAllowlist(egressAllowlist));
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

	/**
	 * Every open Bot lane and its tabs, for the owner's live view. Never creates
	 * a lane: a lane only exists once its agent has used the browser.
	 */
	lanes(): { agentId: string; tabs: TabInfo[] }[] {
		return [...this.profiles].map(([agentId, profile]) => ({
			agentId,
			tabs: profile.tabs.list(),
		}));
	}

	/** One open lane's tab as a read-only live-view source, or null. */
	liveViewSource(agentId: string, tabId: string): LiveViewSource | null {
		const key = normalizeBrowserAgentId(agentId);
		const profile = key ? this.profiles.get(key) : undefined;
		return profile?.tabs.liveViewSource(tabId) ?? null;
	}

	/** The folder holding every managed-Bot profile and the legacy markers. */
	managedBotsRoot(): string {
		return this.root;
	}

	/** Every open lane by profile id (`bot-profiles.ts`). */
	openProfiles(): Map<string, { agentId: string; tabs: TabManager }> {
		const open = new Map<string, { agentId: string; tabs: TabManager }>();
		for (const [agentId, profile] of this.profiles) {
			open.set(profileIdFor(agentId), { agentId, tabs: profile.tabs });
		}
		return open;
	}

	/**
	 * Close an agent's lane: its tabs and hidden window. Its profile (sign-ins,
	 * history) stays, and its next browser call opens a new lane, which reports a
	 * new browser session id. False when the agent has no open lane.
	 */
	closeLane(agentId: string): boolean {
		const key = normalizeBrowserAgentId(agentId);
		const profile = key ? this.profiles.get(key) : undefined;
		if (!(key && profile)) {
			return false;
		}
		this.profiles.delete(key);
		for (const tab of profile.tabs.list()) {
			profile.tabs.close(tab.id);
		}
		profile.win.destroy();
		profile.store.flush();
		return true;
	}

	/**
	 * Delete one profile: close its lane, clear its Chromium partition's cookies,
	 * site storage and cache, and remove its state folder (history, site
	 * permissions, download list, downloads). False for an unknown id, while
	 * the agent's lane is still being opened, or while the same profile is
	 * already being deleted. No lane opens on the profile until it finishes.
	 */
	async deleteProfile(id: string): Promise<boolean> {
		if (!isBotProfileId(id) || this.closed || this.deleting.has(id)) {
			return false;
		}
		this.deleting.add(id);
		try {
			return await this.deleteProfileNow(id);
		} finally {
			this.deleting.delete(id);
		}
	}

	private async deleteProfileNow(id: string): Promise<boolean> {
		const agentId = [
			...this.profiles.keys(),
			...this.pendingProfiles.keys(),
			...this.stores.keys(),
		].find((key) => profileIdFor(key) === id);
		if (agentId !== undefined && this.pendingProfiles.has(agentId)) {
			return false;
		}
		const folder = join(botProfilesRoot(this.root), id);
		if (agentId === undefined && !existsSync(folder)) {
			return false;
		}
		if (agentId !== undefined) {
			this.closeLane(agentId);
		}
		const partitionSession = session.fromPartition(`persist:${id}`);
		await partitionSession.clearStorageData();
		await partitionSession.clearCache();
		rmSync(folder, { force: true, recursive: true });
		const store = agentId === undefined ? undefined : this.stores.get(agentId);
		if (agentId !== undefined && store) {
			// The partition's permission and download handlers stay bound to this
			// store, so empty it in place and give it back an empty folder.
			emptyStore(store);
			mkdirSync(botProfilePaths(this.root, agentId).downloadDirectory, {
				recursive: true,
			});
			store.flush();
		}
		return true;
	}

	/** Every cookie a profile's partition holds; the caller strips the values. */
	profileCookies(id: string): Promise<ChromiumCookie[]> {
		if (!isBotProfileId(id)) {
			return Promise.resolve([]);
		}
		return session.fromPartition(`persist:${id}`).cookies.get({});
	}

	private async createProfile(key: string): Promise<TabManager | null> {
		let botSession: Session;
		let store: BrowserStateStore;
		try {
			store = this.storeFor(key);
			botSession = await this.ensureBotSession(key, store);
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
			key,
			pinWebRtcToProxy
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
		key: string,
		store: BrowserStateStore
	): Promise<Session> {
		const partition = botSessionPartition(key);
		const cached = this.sessions.get(partition);
		if (cached) {
			return cached;
		}
		const configured = this.configureBotSession(key, partition, store);
		this.sessions.set(partition, configured);
		configured.catch(() => this.sessions.delete(partition));
		return configured;
	}

	private async configureBotSession(
		key: string,
		partition: string,
		store: BrowserStateStore
	): Promise<Session> {
		this.network.assertNoBypass();
		const allows = (host: string) => this.egress.allows(key, host);
		const botSession = session.fromPartition(partition);
		const proxy = await this.network.startProxy(allows);
		try {
			if (this.closed) {
				throw new Error("browser is shutting down");
			}
			await this.network.route(botSession, proxy.port);
		} catch (error) {
			proxy.close();
			throw error;
		}
		this.proxies.set(partition, proxy.close);
		installNavigationGuard(botSession, allows);
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
		for (const close of this.proxies.values()) {
			close();
		}
		this.proxies.clear();
	}
}

/** Every loopback spelling a page could use to reach a local service. */
export const NETWORK_GUARD_PROBES = [
	"http://127.0.0.1/",
	"http://localhost/",
	"http://[::1]/",
];

/**
 * Send every request from a Chromium session through the guarded SOCKS proxy,
 * and fail closed when Chromium does not report the proxy as effective.
 */
export async function routeThroughNetworkGuard(
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

/**
 * Re-screen every Chromium main-frame navigation, including redirect hops.
 * With `allowsHost` (a Bot lane's egress allowlist), any request to another
 * host is cancelled before it reaches the proxy, which refuses it as well.
 */
export function installNavigationGuard(
	browserSession: Session,
	allowsHost?: DestinationFilter
): void {
	browserSession.webRequest.onBeforeRequest(
		{ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
		(details, callback) => {
			if (allowsHost && !allowsHost(requestHost(details.url))) {
				callback({ cancel: true });
				return;
			}
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

function requestHost(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

export function normalizeBrowserAgentId(value: string): string | null {
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
