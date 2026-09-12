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
	cdpRestartRequired: boolean;
	deviceToolbar: boolean;
	downloads: BrowserDownloadEntry[];
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
	value: Partial<BrowserSettings> | undefined,
	downloadDirectory: string
): BrowserSettings {
	const defaults = defaultBrowserSettings(downloadDirectory);
	const candidate = value ?? {};
	return {
		allowControl:
			typeof candidate.allowControl === "boolean"
				? candidate.allowControl
				: defaults.allowControl,
		annotationScreenshots:
			candidate.annotationScreenshots === "always" ||
			candidate.annotationScreenshots === "ask" ||
			candidate.annotationScreenshots === "never"
				? candidate.annotationScreenshots
				: defaults.annotationScreenshots,
		approval:
			candidate.approval === "always-allow" ||
			candidate.approval === "always-ask"
				? candidate.approval
				: defaults.approval,
		askWhereToSave:
			typeof candidate.askWhereToSave === "boolean"
				? candidate.askWhereToSave
				: defaults.askWhereToSave,
		developerCdp:
			typeof candidate.developerCdp === "boolean"
				? candidate.developerCdp
				: defaults.developerCdp,
		downloadDirectory:
			typeof candidate.downloadDirectory === "string" &&
			candidate.downloadDirectory.trim().length > 0
				? candidate.downloadDirectory
				: defaults.downloadDirectory,
		historyAccess:
			candidate.historyAccess === "always-allow" ||
			candidate.historyAccess === "always-ask"
				? candidate.historyAccess
				: defaults.historyAccess,
		localLinkDestination:
			candidate.localLinkDestination === "default" ||
			candidate.localLinkDestination === "ryu"
				? candidate.localLinkDestination
				: defaults.localLinkDestination,
		sitePermissions: Array.isArray(candidate.sitePermissions)
			? candidate.sitePermissions.filter(isSitePermission)
			: defaults.sitePermissions,
		webLinkDestination:
			candidate.webLinkDestination === "default" ||
			candidate.webLinkDestination === "ryu"
				? candidate.webLinkDestination
				: defaults.webLinkDestination,
	};
}

/** Build the URL Electron needs when importing an exported cookie. */
export function cookieImportUrl(
	cookieUrl: unknown,
	cookieDomain: unknown,
	path: string
): string {
	if (typeof cookieUrl === "string") {
		return cookieUrl;
	}
	if (typeof cookieDomain !== "string" || cookieDomain.length === 0) {
		return "";
	}
	return `https://${cookieDomain.replace(/^\./, "")}${path}`;
}

/** Keep a browser-suggested filename inside the configured download directory. */
export function safeDownloadFilename(value: unknown): string {
	if (typeof value !== "string") {
		return "download";
	}
	const normalized = value.replaceAll("\\", "/");
	const filename = normalized.slice(normalized.lastIndexOf("/") + 1).trim();
	return filename && filename !== "." && filename !== ".."
		? filename
		: "download";
}

function isSitePermission(value: unknown): value is SitePermission {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<SitePermission>;
	return (
		typeof candidate.origin === "string" &&
		candidate.origin.length > 0 &&
		isPermission(candidate.permission) &&
		(candidate.decision === "allow" || candidate.decision === "deny")
	);
}

function isPermission(value: unknown): value is BrowserPermission {
	return (
		value === "camera" ||
		value === "microphone" ||
		value === "geolocation" ||
		value === "notifications" ||
		value === "clipboard-read"
	);
}

export function isBrowserPermission(
	value: unknown
): value is BrowserPermission {
	return isPermission(value);
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "0 B";
	}
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
	return new Date(timestamp).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}
