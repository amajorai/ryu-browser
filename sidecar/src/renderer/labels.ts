/**
 * Localized labels for the shell's stored values (setting options, site
 * permissions, download states, activity kinds) and its menu. Pure, so the
 * unit tests can check them without a DOM.
 */

import { shellLocale, tl } from "../i18n/shell-i18n.ts";
import type { BrowserActivity } from "../main/activity.ts";
import type { BrowserDownloadRecord } from "../main/browser-state.ts";

/** Title-cased fallback for a value this build has no label for. */
function titleCase(value: string): string {
	return value
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/** The label of a `<select>` option or a stored setting/permission value. */
export function optionLabel(value: string): string {
	switch (value) {
		case "allow":
			return tl("Allow");
		case "always":
			return tl("Always");
		case "always-allow":
			return tl("Always Allow");
		case "always-ask":
			return tl("Always Ask");
		case "ask":
			return tl("Ask");
		case "camera":
			return tl("Camera");
		case "clipboard-read":
			return tl("Clipboard Read");
		case "default":
			return tl("Default");
		case "deny":
			return tl("Deny");
		case "geolocation":
			return tl("Geolocation");
		case "microphone":
			return tl("Microphone");
		case "never":
			return tl("Never");
		case "notifications":
			return tl("Notifications");
		case "ryu":
			return "Ryu";
		default:
			return titleCase(value);
	}
}

export function activityLabel(activity: BrowserActivity): string {
	switch (activity.kind) {
		case "audio":
			return tl("Audio & video");
		case "camera":
			return tl("Camera");
		case "computer-use":
			return tl("Computer use");
		case "microphone":
			return tl("Microphone");
		case "screen":
			return tl("Screen capture");
	}
	const _exhaustive: never = activity;
	return _exhaustive;
}

/** What the activity is doing (the main process's `detail`, localized). */
export function activityDetail(activity: BrowserActivity): string {
	switch (activity.kind) {
		case "audio":
			return tl("Audio and video playback");
		case "camera":
			return tl("Camera access");
		case "computer-use":
			return tl("Browser control in progress");
		case "microphone":
			return tl("Microphone access");
		case "screen":
			return tl("Screen capture");
	}
	const _exhaustive: never = activity;
	return _exhaustive;
}

export function activityTime(activity: BrowserActivity): string {
	return activity.status === "active" ? tl("Active now") : tl("Just now");
}

/** `value` percent (0–100) in the shell locale ("42%", "42 %", "٪٤٢"). */
export function formatPercent(value: number): string {
	try {
		return new Intl.NumberFormat(shellLocale(), {
			maximumFractionDigits: 0,
			style: "percent",
		}).format(value / 100);
	} catch {
		return `${value}%`;
	}
}

export function downloadStateLabel(
	state: BrowserDownloadRecord["state"]
): string {
	switch (state) {
		case "cancelled":
			return tl("Cancelled");
		case "completed":
			return tl("Completed");
		case "interrupted":
			return tl("Interrupted");
		case "progressing":
			return tl("Downloading");
		default:
			return state;
	}
}

/** The overflow menu's labels. */
export function menuLabels(): {
	browserSettings: string;
	clearBrowsingData: string;
	downloads: string;
	findInPage: string;
	history: string;
	importCookies: string;
	passwords: string;
	screenshot: string;
	showDeviceToolbar: string;
	zoom: string;
} {
	return {
		browserSettings: tl("Browser settings"),
		clearBrowsingData: tl("Clear browsing data"),
		downloads: tl("Downloads"),
		findInPage: tl("Find in page"),
		history: tl("History"),
		importCookies: tl("Import cookies…"),
		passwords: tl("Passwords and autofill"),
		screenshot: tl("Take a screenshot"),
		showDeviceToolbar: tl("Show device toolbar"),
		zoom: tl("Zoom"),
	};
}

/** The toast after a cookie import that returned no message of its own. */
export function cookiesImportedMessage(count: number): string {
	return tl(
		"{count, plural, one {# cookie imported} other {# cookies imported}}",
		{ count }
	);
}
