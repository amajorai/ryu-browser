// A browser runtime built from the Electron fake, for shell and IPC tests.
// Import it only after `installElectronFake()` has run.

import { join } from "node:path";
import type {
	BaseWindow,
	Session,
	WebContents,
	WebContentsView,
} from "electron";
import { BrowserActivityStore } from "../activity.ts";
import type { BrowserExtensionManager } from "../browser-extensions.ts";
import type { BrowserRuntime } from "../browser-shell.ts";
import { BrowserStateStore } from "../browser-state-store.ts";
import { ElectronTabManager } from "../electron-tab-manager.ts";
import {
	electronFakeState,
	FakeBaseWindow,
	FakeSession,
	FakeWebContentsView,
} from "./electron-fake.ts";

export function runtimeFixture(): {
	runtime: BrowserRuntime;
	stripView: FakeWebContentsView;
} {
	const dir = electronFakeState.userData;
	const win = new FakeBaseWindow() as unknown as BaseWindow;
	const stripView = new FakeWebContentsView();
	const activities = new BrowserActivityStore();
	const tabs = new ElectronTabManager(
		new FakeSession("visible") as unknown as Session,
		win,
		() => undefined,
		() => undefined,
		() => undefined,
		activities
	);
	const runtime: BrowserRuntime = {
		activities,
		extensions: { list: () => [] } as unknown as BrowserExtensionManager,
		overlayVisible: false,
		store: new BrowserStateStore(dir, join(dir, "downloads")),
		strip: stripView.webContents as unknown as WebContents,
		stripView: stripView as unknown as WebContentsView,
		surface: "browser",
		tabs,
		themeTokens: {},
		win,
	};
	return { runtime, stripView };
}
