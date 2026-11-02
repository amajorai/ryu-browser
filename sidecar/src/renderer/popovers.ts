/** The toolbar's Downloads and Activity center popovers, and download rows. */
import { tl } from "../i18n/shell-i18n.ts";
import type { BrowserActivity } from "../main/activity.ts";
import type {
	BrowserDownloadRecord,
	BrowserState,
} from "../main/browser-state.ts";
import { formatBytes } from "../main/browser-state.ts";
import { bridge } from "./bridge.ts";
import { button, el, showToast } from "./dom.ts";
import {
	activityDetail,
	activityLabel,
	activityTime,
	downloadStateLabel,
	formatPercent,
} from "./labels.ts";
import { currentState, render, run, ui } from "./shell-state.ts";

export function renderDownloadsPopover(snapshot: BrowserState): HTMLElement {
	const popover = el("div", "downloads-popover");
	const header = el("div", "popover-header");
	header.append(
		el("span", "popover-title", tl("Downloads")),
		button(
			"⌂",
			"popover-icon",
			() => run(() => bridge?.openDownloadsFolder() ?? Promise.resolve()),
			tl("Open downloads folder")
		)
	);
	const list = el("div", "download-list");
	if (snapshot.downloads.length === 0) {
		list.append(el("div", "empty-popover", tl("No downloads yet")));
	} else {
		for (const download of snapshot.downloads.slice(0, 5)) {
			list.append(renderDownloadRow(download, true));
		}
	}
	popover.append(header, list);
	return popover;
}

function activityIcon(activity: BrowserActivity): string {
	switch (activity.kind) {
		case "audio":
			return "◖";
		case "camera":
			return "▣";
		case "computer-use":
			return "⌁";
		case "microphone":
			return "♩";
		case "screen":
			return "▤";
	}
	const _exhaustive: never = activity;
	return _exhaustive;
}

export function renderActivityPopover(snapshot: BrowserState): HTMLElement {
	const popover = el("section", "activity-popover");
	const header = el("div", "activity-header");
	const activeCount = snapshot.activities.filter(
		(activity) => activity.status === "active"
	).length;
	header.append(
		el("div", "activity-heading", tl("Activity")),
		el(
			"div",
			"activity-summary",
			activeCount > 0
				? tl("{count, plural, one {# active item} other {# active items}}", {
						count: activeCount,
					})
				: tl("Nothing active")
		),
		button(
			"×",
			"popover-icon",
			() => {
				ui.activityOpen = false;
				render();
			},
			tl("Close activity center")
		)
	);
	popover.append(header);

	const active = snapshot.activities.filter(
		(activity) => activity.status === "active"
	);
	const recent = snapshot.activities.filter(
		(activity) => activity.status === "recent"
	);
	if (active.length === 0 && recent.length === 0) {
		popover.append(
			el(
				"div",
				"activity-empty",
				tl(
					"Tabs using audio, camera, microphone, screen capture, or computer use will appear here."
				)
			)
		);
		return popover;
	}
	if (active.length > 0) {
		appendActivityGroup(popover, tl("Active"), active);
	}
	if (recent.length > 0) {
		appendActivityGroup(popover, tl("Recently active"), recent);
	}
	return popover;
}

function appendActivityGroup(
	parent: HTMLElement,
	title: string,
	activities: BrowserActivity[]
): void {
	parent.append(el("div", "activity-group-title", title));
	const list = el("div", "activity-list");
	for (const activity of activities) {
		list.append(renderActivityRow(activity));
	}
	parent.append(list);
}

function renderActivityRow(activity: BrowserActivity): HTMLElement {
	const row = el(
		"div",
		`activity-row ${activity.status === "active" ? "active" : "recent"}`
	);
	row.append(
		el(
			"span",
			`activity-icon activity-${activity.kind}`,
			activityIcon(activity)
		)
	);
	const copy = el("div", "activity-copy");
	const subject =
		activity.source === "computer-use"
			? activity.agentLabel
			: activity.tabTitle || tl("New tab");
	copy.append(
		el("div", "activity-title", `${activityLabel(activity)} · ${subject}`),
		el(
			"div",
			"activity-detail",
			`${activityDetail(activity)} · ${activityTime(activity)}`
		)
	);
	row.append(copy);
	if (activity.source === "browser-tab" && activity.selectable) {
		row.classList.add("selectable");
		row.setAttribute("role", "button");
		row.tabIndex = 0;
		row.title = tl("Show this tab");
		const select = () => {
			ui.activityOpen = false;
			render();
			run(
				() => bridge?.select(activity.tabId) ?? Promise.resolve(currentState()),
				tl("Unable to show this tab")
			);
		};
		row.addEventListener("click", select);
		row.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				select();
			}
		});
	}
	return row;
}

function fileExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function fileNameForPath(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts.at(-1) || tl("Saved locally");
}

function downloadStatus(download: BrowserDownloadRecord): string {
	if (download.state === "completed") {
		return formatBytes(download.totalBytes);
	}
	if (download.state === "progressing") {
		return typeof download.percent === "number"
			? formatPercent(download.percent)
			: `${download.percent}%`;
	}
	return downloadStateLabel(download.state);
}

export function renderDownloadRow(
	download: BrowserDownloadRecord,
	compact = false
): HTMLElement {
	const row = el("div", compact ? "download-row compact" : "download-row");
	const fileIcon = el(
		"span",
		"download-file-icon",
		fileExtension(download.filename) === "json" ? "{}" : "▧"
	);
	const details = el("div", "download-details");
	details.append(
		el("div", "download-name", download.filename || tl("Download"))
	);
	details.append(
		el(
			"div",
			"download-status",
			`${downloadStatus(download)} · ${fileNameForPath(download.path)}`
		)
	);
	const more = button(
		"…",
		"download-more",
		() => showToast(tl("Download actions are available from Download history")),
		tl("Download actions")
	);
	row.append(fileIcon, details, more);
	return row;
}
