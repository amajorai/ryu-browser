// Ryu Browser sidecar — Electron main process.
//
// A real-Chromium browser Core spawns as a `local` manifest sidecar. Each tab is a
// modern `WebContentsView` (Electron ≥30) attached under a thin tab-strip renderer.
// The loopback control server (`control.ts`) is the only external surface; the
// window itself is incidental (window-choreography polish is a followup).
//
// CDP: Chromium's remote-debugging port is enabled ONLY when `RYU_BROWSER_CDP=1`
// (off by default), matching the ghost-core CDP precedent's opt-in posture.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	app,
	BaseWindow,
	ipcMain,
	WebContentsView,
	type WebContents,
} from "electron";
import {
	resolveControlPort,
	resolveControlToken,
	startControlServer,
} from "./control.ts";
import type { TabInfo, TabManager } from "./tab-manager.ts";

// Opt-in CDP. Must be set before `app` is ready.
if ((process.env.RYU_BROWSER_CDP ?? "").trim() === "1") {
	app.commandLine.appendSwitch("remote-debugging-port", "9222");
	app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

const TAB_STRIP_HEIGHT = 40;

interface LiveTab {
	id: string;
	view: WebContentsView;
}

/**
 * Electron-backed tab manager: each tab is a `WebContentsView` laid out below the
 * tab-strip renderer. Implements the same `TabManager` interface the control server
 * and its tests share.
 */
class ElectronTabManager implements TabManager {
	private readonly tabs: LiveTab[] = [];
	private active: string | null = null;

	constructor(
		private readonly win: BaseWindow,
		private readonly onChange: () => void
	) {
		win.on("resize", () => this.layout());
	}

	private layout(): void {
		const [width, height] = this.win.getContentSize();
		for (const t of this.tabs) {
			const visible = t.id === this.active;
			t.view.setBounds(
				visible
					? { x: 0, y: TAB_STRIP_HEIGHT, width, height: height - TAB_STRIP_HEIGHT }
					: { x: 0, y: 0, width: 0, height: 0 }
			);
		}
	}

	private info(t: LiveTab): TabInfo {
		return {
			id: t.id,
			url: t.view.webContents.getURL(),
			title: t.view.webContents.getTitle(),
		};
	}

	private find(id: string): LiveTab | undefined {
		return this.tabs.find((t) => t.id === id);
	}

	list(): TabInfo[] {
		return this.tabs.map((t) => this.info(t));
	}

	open(url: string): TabInfo {
		const view = new WebContentsView({
			webPreferences: { contextIsolation: true, nodeIntegration: false },
		});
		const tab: LiveTab = { id: randomUUID(), view };
		this.tabs.push(tab);
		this.win.contentView.addChildView(view);
		this.active = tab.id;
		view.webContents.loadURL(url).catch(() => undefined);
		view.webContents.on("page-title-updated", () => this.onChange());
		this.layout();
		this.onChange();
		return this.info(tab);
	}

	close(id: string): boolean {
		const idx = this.tabs.findIndex((t) => t.id === id);
		if (idx < 0) {
			return false;
		}
		const [tab] = this.tabs.splice(idx, 1);
		this.win.contentView.removeChildView(tab.view);
		tab.view.webContents.close();
		if (this.active === id) {
			this.active = this.tabs.at(-1)?.id ?? null;
		}
		this.layout();
		this.onChange();
		return true;
	}

	navigate(id: string, url: string): TabInfo | null {
		const tab = this.find(id);
		if (!tab) {
			return null;
		}
		this.active = id;
		tab.view.webContents.loadURL(url).catch(() => undefined);
		this.layout();
		this.onChange();
		return this.info(tab);
	}

	async screenshot(id: string): Promise<string | null> {
		const tab = this.find(id);
		if (!tab) {
			return null;
		}
		const image = await tab.view.webContents.capturePage();
		return image.toPNG().toString("base64");
	}

	eval(id: string, expression: string): Promise<unknown> {
		const tab = this.find(id);
		if (!tab) {
			return Promise.reject(new Error("no such tab"));
		}
		// PRIVILEGED: Chromium's own JS evaluation in the tab's isolated web contents.
		// Grant-gated (`browser:control`) + bearer-authed + loopback-only upstream.
		return tab.view.webContents.executeJavaScript(expression, true);
	}

	title(id: string): string | null {
		const tab = this.find(id);
		return tab ? tab.view.webContents.getTitle() : null;
	}
}

function createWindow(): { win: BaseWindow; strip: WebContents } {
	const win = new BaseWindow({ width: 1200, height: 800, show: true });
	const strip = new WebContentsView({
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	win.contentView.addChildView(strip);
	const [width] = win.getContentSize();
	strip.setBounds({ x: 0, y: 0, width, height: TAB_STRIP_HEIGHT });
	win.on("resize", () => {
		const [w] = win.getContentSize();
		strip.setBounds({ x: 0, y: 0, width: w, height: TAB_STRIP_HEIGHT });
	});
	// Renderer served by electron-vite (dev) or the built file (prod).
	if (process.env.ELECTRON_RENDERER_URL) {
		strip.webContents.loadURL(process.env.ELECTRON_RENDERER_URL).catch(() => undefined);
	} else {
		strip.webContents
			.loadFile(join(import.meta.dirname, "../renderer/index.html"))
			.catch(() => undefined);
	}
	return { win, strip: strip.webContents };
}

app.whenReady().then(() => {
	const { win, strip } = createWindow();
	const token = resolveControlToken();
	if (!token) {
		// biome-ignore lint/suspicious/noConsole: main-process diagnostic, no renderer.
		console.warn(
			"[ryu-browser] no RYU_EXT_TOKEN/RYU_BROWSER_TOKEN set — control server is FAIL-CLOSED (all protected routes reject). Core injects RYU_EXT_TOKEN when it spawns this sidecar."
		);
	}
	const tabs = new ElectronTabManager(win, () => {
		// Push a lightweight tab snapshot to the strip renderer.
		strip.send("ryu-browser:tabs", tabs.list());
	});
	ipcMain.handle("ryu-browser:list", () => tabs.list());
	startControlServer({ tabs, token }, resolveControlPort());
});

app.on("window-all-closed", () => {
	// Keep running headless: Core manages this sidecar's lifecycle (lazy + idle-stop),
	// so closing the window must not kill the control server on non-macOS either.
	// (No-op; do not app.quit().)
});
