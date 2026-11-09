// Managed-Bot browser profiles on disk, for the owner's profile API.
//
// Each agent's lane keeps a persistent Chromium partition (`persist:<id>`) and a
// state folder (`managed-bots/agents/<id>/`) holding its history, saved site
// permissions, download list and downloads (`bot-partition.ts`). The profile id
// is that folder name: it is derived from the agent id, limited to `[a-z0-9-]`,
// and never contains a path separator, so it is safe to accept back from a
// request once it matches `BOT_PROFILE_ID`.
//
// An export carries what the owner can review — history, site permissions, the
// download list and the names of the cookies the profile holds — and never a
// cookie value or site storage: those are live sign-ins, and the agent's
// credentials never leave the sidecar.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BOT_PARTITION_PREFIX,
	BOT_PROFILES_DIRECTORY,
	botSessionPartition,
} from "./bot-partition.ts";
import { browserPersistedProfileSchema } from "./browser-records.ts";
import { normalizeBrowserSettings } from "./browser-state.ts";
import type { BrowserStateStore } from "./browser-state-store.ts";

const PROFILE_FOLDER_PREFIX = BOT_PARTITION_PREFIX.slice("persist:".length);

/** A profile id: the partition name without `persist:`. */
export const BOT_PROFILE_ID = /^ryu-bot-[a-z0-9-]{1,80}$/;

/** Entries a size walk visits before it reports the size as a lower bound. */
const MAX_WALK_ENTRIES = 20_000;

/** Cookies listed in one export. */
export const MAX_EXPORTED_COOKIES = 2000;

/** Upper bound on one exported cookie field. */
const MAX_COOKIE_FIELD = 256;

/** True when `value` is a well-formed managed-Bot profile id. */
export function isBotProfileId(value: string): boolean {
	return BOT_PROFILE_ID.test(value) && value.startsWith(PROFILE_FOLDER_PREFIX);
}

/** The folder that holds every agent's state folder. */
export function botProfilesRoot(managedBotsRoot: string): string {
	return join(managedBotsRoot, BOT_PROFILES_DIRECTORY);
}

/** Every profile id with a state folder on disk, sorted. */
export function botProfileIds(managedBotsRoot: string): string[] {
	const root = botProfilesRoot(managedBotsRoot);
	if (!existsSync(root)) {
		return [];
	}
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && isBotProfileId(entry.name))
		.map((entry) => entry.name)
		.sort();
}

/**
 * Bytes under `path`, without following symlinks. Stops counting after a fixed
 * number of entries, so one huge profile cannot stall the control server.
 */
export function directoryBytes(path: string): number {
	let total = 0;
	let visited = 0;
	const pending = [path];
	while (pending.length > 0 && visited < MAX_WALK_ENTRIES) {
		const current = pending.pop() as string;
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(current);
		} catch {
			continue;
		}
		visited += 1;
		if (stats.isDirectory()) {
			try {
				for (const name of readdirSync(current)) {
					pending.push(join(current, name));
				}
			} catch {
				// An unreadable folder counts as empty.
			}
		} else if (stats.isFile()) {
			total += stats.size;
		}
	}
	return total;
}

export interface BotProfileState {
	downloads: {
		filename: string;
		state: string;
		updatedAt: number;
		url: string;
	}[];
	history: { title: string; url: string; visitedAt: number }[];
	sitePermissions: { decision: string; origin: string; permission: string }[];
}

/** The profile's saved state, or empty state when the file is absent or damaged. */
export function readBotProfileState(stateDirectory: string): BotProfileState {
	let raw: unknown = {};
	try {
		raw = JSON.parse(
			readFileSync(join(stateDirectory, "browser-state.json"), "utf8")
		);
	} catch {
		raw = {};
	}
	const parsed = browserPersistedProfileSchema.safeParse(raw);
	const profile = parsed.success
		? parsed.data
		: browserPersistedProfileSchema.parse({});
	return {
		downloads: profile.downloads.map((entry) => ({
			filename: "filename" in entry ? String(entry.filename) : "",
			state: "state" in entry ? String(entry.state) : "completed",
			updatedAt: "updatedAt" in entry ? Number(entry.updatedAt) : 0,
			url: "url" in entry ? String(entry.url) : "",
		})),
		history: profile.history.map(({ title, url, visitedAt }) => ({
			title,
			url,
			visitedAt,
		})),
		sitePermissions: normalizeBrowserSettings(
			profile.settings,
			""
		).sitePermissions.map(({ decision, origin, permission }) => ({
			decision,
			origin,
			permission,
		})),
	};
}

/** Cookie metadata the export may carry. Never a value. */
export interface CookieMetadata {
	domain: string;
	expires: number | null;
	http_only: boolean;
	name: string;
	path: string;
	secure: boolean;
}

/** What Chromium reports for one cookie (Electron's `Cookie`). */
export interface ChromiumCookie {
	domain?: string;
	expirationDate?: number;
	httpOnly?: boolean;
	name: string;
	path?: string;
	secure?: boolean;
	value?: string;
}

/** Strip every cookie to its metadata, dropping the value. */
export function cookieMetadata(
	cookies: readonly ChromiumCookie[]
): CookieMetadata[] {
	const clip = (value: string | undefined) =>
		(value ?? "").slice(0, MAX_COOKIE_FIELD);
	return cookies.slice(0, MAX_EXPORTED_COOKIES).map((cookie) => ({
		domain: clip(cookie.domain),
		expires:
			typeof cookie.expirationDate === "number" ? cookie.expirationDate : null,
		http_only: cookie.httpOnly === true,
		name: clip(cookie.name),
		path: clip(cookie.path),
		secure: cookie.secure === true,
	}));
}

/** The owner's export of one profile. */
export function botProfileExport(
	id: string,
	state: BotProfileState,
	cookies: readonly ChromiumCookie[],
	exportedAt: Date
) {
	return {
		cookies: cookieMetadata(cookies),
		cookies_truncated: cookies.length > MAX_EXPORTED_COOKIES,
		downloads: state.downloads,
		exported_at: exportedAt.toISOString(),
		format: "ryu-browser-profile/1",
		history: state.history,
		id,
		site_permissions: state.sitePermissions,
	};
}

/** Forget a store's history, downloads and saved site permissions. */
export function emptyStore(store: BrowserStateStore): void {
	store.clearHistory();
	store.clearDownloads();
	for (const { origin, permission } of store.getSettings().sitePermissions) {
		store.removeSitePermission(origin, permission);
	}
}

/** The profile id (state folder name) of a normalized agent id. */
export function profileIdFor(agentId: string): string {
	return botSessionPartition(agentId).slice("persist:".length);
}
