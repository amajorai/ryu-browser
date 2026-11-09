import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	type BaseWindow,
	dialog,
	type Session,
	type WebContents,
} from "electron";
import { z } from "zod";
import {
	type BrowserDownloadEntry,
	type BrowserPermission,
	safeDownloadFilename,
} from "./browser-state.ts";
import type { BrowserStateStore } from "./browser-state-store.ts";
import { downloadSaveDialogCopy, permissionPromptCopy } from "./native-copy.ts";

export type BrowserNativePermissionDetails =
	| Parameters<
			NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>
	  >[3]
	| Parameters<
			NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>
	  >[3];

export function permissionOrigin(
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

export function permissionKeys(
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

export function installPermissionHandlers(
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
			const copy = permissionPromptCopy(origin, keys);
			const result = await dialog.showMessageBox(win, {
				buttons: copy.buttons,
				cancelId: 1,
				detail: copy.detail,
				message: copy.message,
				title: copy.title,
				type: "question",
			});
			callback(result.response === 0);
		}
	);
}

export function installDownloadHandlers(
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
				...downloadSaveDialogCopy(),
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
