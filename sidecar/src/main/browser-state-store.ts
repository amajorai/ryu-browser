// The local browser profile store (settings, history, downloads).

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
import { browserPersistedProfileSchema } from "./browser-records.ts";
import {
	type BrowserDownloadEntry,
	type BrowserDownloadRecord,
	type BrowserHistoryEntry,
	type BrowserPermission,
	type BrowserSettings,
	normalizeBrowserSettings,
} from "./browser-state.ts";
import { restrictToOwner } from "./profile-storage.ts";

const DOWNLOAD_PERSIST_DELAY_MS = 250;

/** Small, local-only store for browser preferences and non-sensitive metadata. */
export class BrowserStateStore {
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
