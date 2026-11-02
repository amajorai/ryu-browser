// Shell menu actions that open native dialogs: screenshots and cookie import.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dialog, session } from "electron";
import { cookieImportUrl } from "./browser-state.ts";
import {
	browserCookieExportSchema,
	browserImportedCookieSchema,
} from "./cookie-records.ts";
import {
	cookieImportDialogCopy,
	cookieImportMessages,
	screenshotSaveDialogCopy,
} from "./native-copy.ts";
import { runtime } from "./shell-runtime.ts";

export async function saveActiveScreenshot(): Promise<{
	saved: boolean;
	path?: string;
}> {
	if (!runtime) {
		return { saved: false };
	}
	const image = await runtime.tabs.activeScreenshot();
	if (!image) {
		return { saved: false };
	}
	const copy = screenshotSaveDialogCopy();
	const result = await dialog.showSaveDialog(runtime.win, {
		buttonLabel: copy.buttonLabel,
		defaultPath: join(
			runtime.store.getSettings().downloadDirectory,
			`ryu-browser-${Date.now()}.png`
		),
		filters: [{ extensions: ["png"], name: copy.filterName }],
	});
	if (result.canceled || !result.filePath) {
		return { saved: false };
	}
	writeFileSync(result.filePath, image.toPNG());
	return { path: result.filePath, saved: true };
}

export async function importCookies(): Promise<{
	imported: number;
	message?: string;
}> {
	if (!runtime) {
		return { imported: 0, message: cookieImportMessages.unavailable() };
	}
	const copy = cookieImportDialogCopy();
	const selected = await dialog.showOpenDialog(runtime.win, {
		filters: [{ extensions: ["json"], name: copy.filterName }],
		properties: ["openFile"],
		title: copy.title,
	});
	if (selected.canceled || !selected.filePaths[0]) {
		return { imported: 0, message: cookieImportMessages.cancelled() };
	}
	try {
		const parsedExport = browserCookieExportSchema.safeParse(
			JSON.parse(readFileSync(selected.filePaths[0], "utf8"))
		);
		const list = parsedExport.success
			? Array.isArray(parsedExport.data)
				? parsedExport.data
				: parsedExport.data.cookies
			: [];
		let imported = 0;
		for (const value of list.slice(0, 500)) {
			const parsedCookie = browserImportedCookieSchema.safeParse(value);
			if (!parsedCookie.success) {
				continue;
			}
			const cookie = parsedCookie.data;
			const name = cookie.name;
			const cookieValue = cookie.value;
			const domain = cookie.domain;
			const path = cookie.path;
			const url = cookieImportUrl(cookie.url, domain, path);
			if (!(name && url && /^https?:\/\//i.test(url))) {
				continue;
			}
			await session.defaultSession.cookies.set({
				domain: domain || undefined,
				expirationDate: cookie.expirationDate,
				httpOnly: cookie.httpOnly === true,
				name,
				path,
				sameSite: cookie.sameSite,
				secure: cookie.secure === true,
				url,
				value: cookieValue,
			});
			imported += 1;
		}
		return { imported, message: cookieImportMessages.imported(imported) };
	} catch {
		return { imported: 0, message: cookieImportMessages.unreadable() };
	}
}
