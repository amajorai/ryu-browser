import { z } from "zod";
import type { BrowserActivity } from "./activity.ts";
import {
	type BrowserCookieText,
	type BrowserLegacyDownloadEntry,
	type BrowserPermissionCandidate,
	type BrowserPersistedSettings,
	type BrowserStoredDownloadQuantity,
	type BrowserSuggestedFilename,
	browserPermissionSchema,
	browserStoredSettingsSchema,
} from "./browser-records.ts";

export type BrowserSurface =
	| "browser"
	| "settings"
	| "history"
	| "downloads"
	| "passwords"
	| "permissions";

export type BrowserLinkDestination = "default" | "ryu";
export type AnnotationScreenshotPolicy = "always" | "ask" | "never";
export type PermissionDecision = "allow" | "deny";
export type BrowserPermission =
	| "camera"
	| "microphone"
	| "geolocation"
	| "notifications"
	| "clipboard-read";

export interface SitePermission {
	decision: PermissionDecision;
	origin: string;
	permission: BrowserPermission;
}

export interface BrowserSettings {
	allowControl: boolean;
	annotationScreenshots: AnnotationScreenshotPolicy;
	approval: "always-allow" | "always-ask";
	askWhereToSave: boolean;
	developerCdp: boolean;
	downloadDirectory: string;
	historyAccess: "always-allow" | "always-ask";
	localLinkDestination: BrowserLinkDestination;
	sitePermissions: SitePermission[];
	webLinkDestination: BrowserLinkDestination;
}

export interface BrowserHistoryEntry {
	id: string;
	title: string;
	url: string;
	visitedAt: number;
}

export type BrowserDownloadState =
	| "progressing"
	| "completed"
	| "cancelled"
	| "interrupted";

export interface BrowserDownloadEntry {
	filename: string;
	id: string;
	path: string;
	percent: number;
	receivedBytes: number;
	state: BrowserDownloadState;
	totalBytes: number;
	updatedAt: number;
	url: string;
}

export type BrowserDownloadRecord =
	| BrowserDownloadEntry
	| BrowserLegacyDownloadEntry;

export interface BrowserExtension {
	id: string;
	name: string;
	version: string;
}

export interface BrowserTabState {
	canGoBack: boolean;
	canGoForward: boolean;
	id: string;
	loading: boolean;
	title: string;
	url: string;
	zoomPercent: number;
}

export interface BrowserState {
	activeId: string | null;
	activeTitle: string;
	activeUrl: string;
	activities: BrowserActivity[];
	cdpRestartRequired: boolean;
	deviceToolbar: boolean;
	downloads: BrowserDownloadRecord[];
	extensions: BrowserExtension[];
	history: BrowserHistoryEntry[];
	settings: BrowserSettings;
	surface: BrowserSurface;
	tabs: BrowserTabState[];
}

export const BROWSER_CHROME_HEIGHT = 104;

export function defaultBrowserSettings(
	downloadDirectory: string
): BrowserSettings {
	return {
		allowControl: true,
		annotationScreenshots: "always",
		approval: "always-allow",
		askWhereToSave: false,
		developerCdp: false,
		downloadDirectory,
		historyAccess: "always-ask",
		localLinkDestination: "ryu",
		sitePermissions: [],
		webLinkDestination: "default",
	};
}

export function normalizeBrowserSettings(
	value: BrowserPersistedSettings,
	downloadDirectory: string
): BrowserSettings {
	return browserStoredSettingsSchema(
		defaultBrowserSettings(downloadDirectory)
	).parse(value ?? {});
}

/** Build the URL Electron needs when importing an exported cookie. */
export function cookieImportUrl(
	cookieUrl: BrowserCookieText,
	cookieDomain: BrowserCookieText,
	path: string
): string {
	const url = z.string().safeParse(cookieUrl);
	if (url.success) {
		return url.data;
	}
	const domain = z.string().min(1).safeParse(cookieDomain);
	return domain.success
		? `https://${domain.data.replace(/^\./, "")}${path}`
		: "";
}

/** Keep a browser-suggested filename inside the configured download directory. */
export function safeDownloadFilename(value: BrowserSuggestedFilename): string {
	const filenameInput = z.string().safeParse(value);
	if (!filenameInput.success) {
		return "download";
	}
	const normalized = filenameInput.data.replaceAll("\\", "/");
	const filename = normalized.slice(normalized.lastIndexOf("/") + 1).trim();
	return filename && filename !== "." && filename !== ".."
		? filename
		: "download";
}

export function isBrowserPermission(
	value: BrowserPermissionCandidate
): value is BrowserPermission {
	return browserPermissionSchema.safeParse(value).success;
}

export function formatBytes(value: BrowserStoredDownloadQuantity): string {
	const parsed = z.number().safeParse(value);
	if (!parsed.success || parsed.data <= 0) {
		return "0 B";
	}
	const bytes = parsed.data;
	const units = ["B", "KB", "MB", "GB"];
	const index = Math.min(
		units.length - 1,
		Math.floor(Math.log(bytes) / Math.log(1024))
	);
	return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatRelativeTime(
	timestamp: number,
	now = Date.now()
): string {
	const age = Math.max(0, now - timestamp);
	if (age < 60_000) {
		return "Just now";
	}
	if (age < 3_600_000) {
		return `${Math.floor(age / 60_000)} min ago`;
	}
	if (age < 86_400_000) {
		return `${Math.floor(age / 3_600_000)} hr ago`;
	}
	const date = new Date(timestamp);
	const styles = globalThis.document
		? getComputedStyle(globalThis.document.documentElement)
		: undefined;
	const localeToken = styles?.getPropertyValue("--ryu-locale").trim() ?? "";
	const timezoneToken = styles?.getPropertyValue("--ryu-timezone").trim() ?? "";
	const locale =
		localeToken && localeToken !== "system" ? localeToken : undefined;
	const timeZone =
		timezoneToken && timezoneToken !== "system" ? timezoneToken : undefined;
	try {
		return new Intl.DateTimeFormat(locale, {
			day: "numeric",
			month: "short",
			timeZone,
		}).format(date);
	} catch {
		return new Intl.DateTimeFormat(locale, {
			day: "numeric",
			month: "short",
		}).format(date);
	}
}
