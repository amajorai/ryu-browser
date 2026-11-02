// Managed-Bot browser lanes: one hidden window, tab manager, Chromium
// partition and state store per Core-derived agent identity.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BaseWindow, type Session, session } from "electron";
import type { BrowserActivityStore } from "./activity.ts";
import {
	botProfilePaths,
	botSessionPartition,
	LEGACY_BOT_PARTITION_CLEARED_MARKER,
	LEGACY_SHARED_BOT_PARTITION,
	LEGACY_SHARED_BOT_STATE_FILE,
} from "./bot-partition.ts";
import { BrowserStateStore } from "./browser-state-store.ts";
import { ElectronTabManager } from "./electron-tab-manager.ts";
import { FALLBACK_VIEWPORT } from "./electron-tab-support.ts";
import { installNavigationGuard } from "./network-guard.ts";
import {
	installDownloadHandlers,
	installPermissionHandlers,
} from "./session-handlers.ts";
import type { TabManager } from "./tab-manager.ts";

const MAX_BOT_BROWSER_SESSIONS = 64;

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
