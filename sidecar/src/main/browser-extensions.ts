import type { Extension, Session } from "electron";
import type { BrowserExtension } from "./browser-state.ts";

export interface BrowserExtensionPathStore {
	addExtensionPath(path: string): void;
	getExtensionPaths(): string[];
	removeExtensionPath(path: string): void;
}

function extensionInfo(extension: Extension): BrowserExtension {
	return {
		id: extension.id,
		name: extension.name,
		version: extension.version,
	};
}

/** Loads trusted, unpacked Chromium extensions into the visible browser session. */
export class BrowserExtensionManager {
	constructor(
		private readonly browserSession: Session,
		private readonly paths: BrowserExtensionPathStore
	) {}

	async restore(): Promise<void> {
		for (const path of this.paths.getExtensionPaths()) {
			try {
				await this.load(path, false);
			} catch {
				// A removed or incompatible local extension must not stop the browser from
				// opening. The saved path remains so the user can repair it later.
			}
		}
	}

	async load(path: string, persist = true): Promise<BrowserExtension> {
		const normalized = path.trim();
		if (!normalized) {
			throw new Error("Choose an unpacked extension folder");
		}
		const existing = this.browserSession
			.getAllExtensions()
			.find((extension) => extension.path === normalized);
		const extension =
			existing ??
			(await this.browserSession.loadExtension(normalized, {
				allowFileAccess: false,
			}));
		if (persist) {
			this.paths.addExtensionPath(extension.path);
		}
		return extensionInfo(extension);
	}

	remove(id: string): boolean {
		const extension = this.browserSession
			.getAllExtensions()
			.find((candidate) => candidate.id === id);
		if (!extension) {
			return false;
		}
		this.browserSession.removeExtension(extension.id);
		this.paths.removeExtensionPath(extension.path);
		return true;
	}

	list(): BrowserExtension[] {
		return this.browserSession
			.getAllExtensions()
			.map(extensionInfo)
			.sort((left, right) => left.name.localeCompare(right.name));
	}
}
