import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dialog, ipcMain, session, shell } from "electron";
import { z } from "zod";
import {
	browserPermissionSchema,
	browserSurfaceSchema,
} from "./browser-records.ts";
import {
	emitState,
	getBrowserState,
	layoutShell,
	normalizedNavigationUrl,
	setChromeSurface,
	sidecarState,
	updateSetting,
} from "./browser-shell.ts";
import {
	type BrowserPermission,
	type BrowserSettings,
	type BrowserSurface,
	cookieImportUrl,
	type SitePermission,
} from "./browser-state.ts";
import {
	browserCookieExportSchema,
	browserImportedCookieSchema,
} from "./cookie-records.ts";
import {
	cookieImportDialogCopy,
	cookieImportMessages,
	downloadDirectoryDialogTitle,
	extensionDirectoryDialogTitle,
	screenshotSaveDialogCopy,
} from "./native-copy.ts";

export async function saveActiveScreenshot(): Promise<{
	saved: boolean;
	path?: string;
}> {
	if (!sidecarState.runtime) {
		return { saved: false };
	}
	const image = await sidecarState.runtime.tabs.activeScreenshot();
	if (!image) {
		return { saved: false };
	}
	const copy = screenshotSaveDialogCopy();
	const result = await dialog.showSaveDialog(sidecarState.runtime.win, {
		buttonLabel: copy.buttonLabel,
		defaultPath: join(
			sidecarState.runtime.store.getSettings().downloadDirectory,
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
	if (!sidecarState.runtime) {
		return { imported: 0, message: cookieImportMessages.unavailable() };
	}
	const copy = cookieImportDialogCopy();
	const selected = await dialog.showOpenDialog(sidecarState.runtime.win, {
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

export function registerIpcHandlers(): void {
	if (!sidecarState.runtime) {
		return;
	}
	ipcMain.handle(
		"ryu-browser:add-site-permission",
		(_event, input: SitePermission) => {
			const parsedInput = z
				.object({
					origin: z.string(),
					permission: browserPermissionSchema,
					decision: z.enum(["allow", "deny"]),
				})
				.safeParse(input);
			if (!parsedInput.success) {
				throw new Error("Invalid site permission");
			}
			const candidate = parsedInput.data;
			const origin = new URL(candidate.origin);
			if (origin.protocol !== "http:" && origin.protocol !== "https:") {
				throw new Error("Site permissions require an http or https origin");
			}
			sidecarState.runtime?.store.setSitePermission({
				origin: origin.origin,
				permission: candidate.permission,
				decision: candidate.decision,
			});
			emitState();
			return getBrowserState();
		}
	);
	ipcMain.handle("ryu-browser:back", () => {
		sidecarState.runtime?.tabs.back();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:choose-download-directory", async () => {
		if (!sidecarState.runtime) {
			return null;
		}
		const result = await dialog.showOpenDialog(sidecarState.runtime.win, {
			properties: ["createDirectory", "openDirectory"],
			title: downloadDirectoryDialogTitle(),
		});
		if (result.canceled || !result.filePaths[0]) {
			return null;
		}
		sidecarState.runtime.store.setSetting(
			"downloadDirectory",
			result.filePaths[0]
		);
		session.defaultSession.setDownloadPath(result.filePaths[0]);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:clear-browsing-data", async () => {
		await session.defaultSession.clearStorageData();
		sidecarState.runtime?.store.clearHistory();
		sidecarState.runtime?.store.clearDownloads();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:clear-downloads", () => {
		sidecarState.runtime?.store.clearDownloads();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:clear-history", () => {
		sidecarState.runtime?.store.clearHistory();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:close", (_event, id: string) => {
		sidecarState.runtime?.tabs.close(id);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:find", (_event, query: string) => {
		sidecarState.runtime?.tabs.findInPage(query);
	});
	ipcMain.handle("ryu-browser:forward", () => {
		sidecarState.runtime?.tabs.forward();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:get-state", () => getBrowserState());
	ipcMain.handle("ryu-browser:get-theme", () => ({
		...sidecarState.runtime?.themeTokens,
	}));
	ipcMain.handle("ryu-browser:import-cookies", () => importCookies());
	ipcMain.handle("ryu-browser:choose-extension-directory", async () => {
		if (!sidecarState.runtime) {
			return null;
		}
		const result = await dialog.showOpenDialog(sidecarState.runtime.win, {
			properties: ["openDirectory"],
			title: extensionDirectoryDialogTitle(),
		});
		const path = result.filePaths[0];
		if (result.canceled || !path) {
			return null;
		}
		await sidecarState.runtime.extensions.load(path);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle(
		"ryu-browser:list",
		() => sidecarState.runtime?.tabs.list() ?? []
	);
	ipcMain.handle("ryu-browser:navigate", async (_event, value: string) => {
		const url = await normalizedNavigationUrl(value);
		const id = sidecarState.runtime?.tabs.activeId();
		if (id) {
			sidecarState.runtime?.tabs.navigate(id, url);
		} else {
			sidecarState.runtime?.tabs.open(url);
		}
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:open", async (_event, value?: string) => {
		const url = value ? await normalizedNavigationUrl(value) : "about:blank";
		sidecarState.runtime?.tabs.open(url);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:open-downloads-folder", async () => {
		if (sidecarState.runtime) {
			await shell.openPath(
				sidecarState.runtime.store.getSettings().downloadDirectory
			);
		}
	});
	ipcMain.handle("ryu-browser:open-devtools", () =>
		sidecarState.runtime?.tabs.openDevTools()
	);
	ipcMain.handle(
		"ryu-browser:remove-site-permission",
		(_event, origin: string, permission: BrowserPermission) => {
			const parsedPermission = browserPermissionSchema.safeParse(permission);
			if (!(sidecarState.runtime && parsedPermission.success)) {
				throw new Error("Invalid site permission");
			}
			sidecarState.runtime.store.removeSitePermission(
				origin,
				parsedPermission.data
			);
			emitState();
			return getBrowserState();
		}
	);
	ipcMain.handle("ryu-browser:remove-extension", (_event, id: string) => {
		const parsedId = z.string().safeParse(id);
		if (
			!(
				sidecarState.runtime &&
				parsedId.success &&
				sidecarState.runtime.extensions.remove(parsedId.data)
			)
		) {
			throw new Error("No such browser extension");
		}
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:reload", () => {
		sidecarState.runtime?.tabs.reload();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:select", (_event, id: string) => {
		if (!sidecarState.runtime?.tabs.select(id)) {
			throw new Error("No such browser tab");
		}
		emitState();
		return getBrowserState();
	});
	ipcMain.handle(
		"ryu-browser:set-overlay-visible",
		(_event, visible: boolean) => {
			const parsedVisible = z.boolean().safeParse(visible);
			if (!(sidecarState.runtime && parsedVisible.success)) {
				throw new Error("Invalid browser overlay state");
			}
			sidecarState.runtime.overlayVisible = parsedVisible.data;
			layoutShell();
		}
	);
	ipcMain.handle("ryu-browser:set-cdp-enabled", (_event, enabled: boolean) => {
		const parsedEnabled = z.boolean().safeParse(enabled);
		if (!(sidecarState.runtime && parsedEnabled.success)) {
			throw new Error("Invalid CDP setting");
		}
		sidecarState.runtime.store.setSetting("developerCdp", parsedEnabled.data);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle(
		"ryu-browser:set-setting",
		(
			_event,
			key: keyof BrowserSettings,
			value: BrowserSettings[keyof BrowserSettings]
		) => {
			updateSetting(key, value);
			emitState();
			return getBrowserState();
		}
	);
	ipcMain.handle(
		"ryu-browser:set-surface",
		(_event, surface: BrowserSurface) => {
			const parsedSurface = browserSurfaceSchema.safeParse(surface);
			if (!parsedSurface.success) {
				throw new Error("Invalid browser surface");
			}
			setChromeSurface(parsedSurface.data);
			return getBrowserState();
		}
	);
	ipcMain.handle("ryu-browser:show-screenshot", () => saveActiveScreenshot());
	ipcMain.handle("ryu-browser:stop-find", () =>
		sidecarState.runtime?.tabs.stopFindInPage()
	);
	ipcMain.handle("ryu-browser:toggle-device-toolbar", () => {
		sidecarState.runtime?.tabs.toggleDeviceToolbar();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle(
		"ryu-browser:zoom",
		(_event, action: "in" | "out" | "reset") => {
			if (action !== "in" && action !== "out" && action !== "reset") {
				throw new Error("Invalid zoom action");
			}
			sidecarState.runtime?.tabs.zoom(action);
			emitState();
			return getBrowserState();
		}
	);
}
