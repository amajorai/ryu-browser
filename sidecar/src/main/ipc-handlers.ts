// The `ryu-browser:*` IPC handlers the shell renderer calls through preload.

import { dialog, ipcMain, session, shell } from "electron";
import { z } from "zod";
import {
	browserPermissionSchema,
	browserSurfaceSchema,
} from "./browser-records.ts";
import type {
	BrowserPermission,
	BrowserSettings,
	BrowserSurface,
	SitePermission,
} from "./browser-state.ts";
import {
	downloadDirectoryDialogTitle,
	extensionDirectoryDialogTitle,
} from "./native-copy.ts";
import { importCookies, saveActiveScreenshot } from "./shell-actions.ts";
import {
	emitState,
	getBrowserState,
	layoutShell,
	normalizedNavigationUrl,
	runtime,
	setChromeSurface,
	updateSetting,
} from "./shell-runtime.ts";

export function registerIpcHandlers(): void {
	if (!runtime) {
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
			runtime?.store.setSitePermission({
				origin: origin.origin,
				permission: candidate.permission,
				decision: candidate.decision,
			});
			emitState();
			return getBrowserState();
		}
	);
	ipcMain.handle("ryu-browser:back", () => {
		runtime?.tabs.back();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:choose-download-directory", async () => {
		if (!runtime) {
			return null;
		}
		const result = await dialog.showOpenDialog(runtime.win, {
			properties: ["createDirectory", "openDirectory"],
			title: downloadDirectoryDialogTitle(),
		});
		if (result.canceled || !result.filePaths[0]) {
			return null;
		}
		runtime.store.setSetting("downloadDirectory", result.filePaths[0]);
		session.defaultSession.setDownloadPath(result.filePaths[0]);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:clear-browsing-data", async () => {
		await session.defaultSession.clearStorageData();
		runtime?.store.clearHistory();
		runtime?.store.clearDownloads();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:clear-downloads", () => {
		runtime?.store.clearDownloads();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:clear-history", () => {
		runtime?.store.clearHistory();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:close", (_event, id: string) => {
		runtime?.tabs.close(id);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:find", (_event, query: string) => {
		runtime?.tabs.findInPage(query);
	});
	ipcMain.handle("ryu-browser:forward", () => {
		runtime?.tabs.forward();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:get-state", () => getBrowserState());
	ipcMain.handle("ryu-browser:get-theme", () => ({ ...runtime?.themeTokens }));
	ipcMain.handle("ryu-browser:import-cookies", () => importCookies());
	ipcMain.handle("ryu-browser:choose-extension-directory", async () => {
		if (!runtime) {
			return null;
		}
		const result = await dialog.showOpenDialog(runtime.win, {
			properties: ["openDirectory"],
			title: extensionDirectoryDialogTitle(),
		});
		const path = result.filePaths[0];
		if (result.canceled || !path) {
			return null;
		}
		await runtime.extensions.load(path);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:list", () => runtime?.tabs.list() ?? []);
	ipcMain.handle("ryu-browser:navigate", async (_event, value: string) => {
		const url = await normalizedNavigationUrl(value);
		const id = runtime?.tabs.activeId();
		if (id) {
			runtime?.tabs.navigate(id, url);
		} else {
			runtime?.tabs.open(url);
		}
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:open", async (_event, value?: string) => {
		const url = value ? await normalizedNavigationUrl(value) : "about:blank";
		runtime?.tabs.open(url);
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:open-downloads-folder", async () => {
		if (runtime) {
			await shell.openPath(runtime.store.getSettings().downloadDirectory);
		}
	});
	ipcMain.handle("ryu-browser:open-devtools", () =>
		runtime?.tabs.openDevTools()
	);
	ipcMain.handle(
		"ryu-browser:remove-site-permission",
		(_event, origin: string, permission: BrowserPermission) => {
			const parsedPermission = browserPermissionSchema.safeParse(permission);
			if (!(runtime && parsedPermission.success)) {
				throw new Error("Invalid site permission");
			}
			runtime.store.removeSitePermission(origin, parsedPermission.data);
			emitState();
			return getBrowserState();
		}
	);
	ipcMain.handle("ryu-browser:remove-extension", (_event, id: string) => {
		const parsedId = z.string().safeParse(id);
		if (
			!(runtime && parsedId.success && runtime.extensions.remove(parsedId.data))
		) {
			throw new Error("No such browser extension");
		}
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:reload", () => {
		runtime?.tabs.reload();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle("ryu-browser:select", (_event, id: string) => {
		if (!runtime?.tabs.select(id)) {
			throw new Error("No such browser tab");
		}
		emitState();
		return getBrowserState();
	});
	ipcMain.handle(
		"ryu-browser:set-overlay-visible",
		(_event, visible: boolean) => {
			const parsedVisible = z.boolean().safeParse(visible);
			if (!(runtime && parsedVisible.success)) {
				throw new Error("Invalid browser overlay state");
			}
			runtime.overlayVisible = parsedVisible.data;
			layoutShell();
		}
	);
	ipcMain.handle("ryu-browser:set-cdp-enabled", (_event, enabled: boolean) => {
		const parsedEnabled = z.boolean().safeParse(enabled);
		if (!(runtime && parsedEnabled.success)) {
			throw new Error("Invalid CDP setting");
		}
		runtime.store.setSetting("developerCdp", parsedEnabled.data);
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
	ipcMain.handle("ryu-browser:stop-find", () => runtime?.tabs.stopFindInPage());
	ipcMain.handle("ryu-browser:toggle-device-toolbar", () => {
		runtime?.tabs.toggleDeviceToolbar();
		emitState();
		return getBrowserState();
	});
	ipcMain.handle(
		"ryu-browser:zoom",
		(_event, action: "in" | "out" | "reset") => {
			if (action !== "in" && action !== "out" && action !== "reset") {
				throw new Error("Invalid zoom action");
			}
			runtime?.tabs.zoom(action);
			emitState();
			return getBrowserState();
		}
	);
}
