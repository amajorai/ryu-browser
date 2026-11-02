// Ryu Browser sidecar — Electron main process.
//
// A real-Chromium browser Core spawns as a `local` manifest sidecar. Each tab is a
// modern `WebContentsView` (Electron ≥30) attached under a native browser shell.
// The loopback control server (`control.ts`) and the shell renderer share the
// same user tab manager; managed cloud Bot calls are routed by the Core-derived
// identity to hidden tab lanes, each in that agent's own persistent Chromium
// partition with its own history, site permissions, and downloads folder.
//
// CDP, two independent things — do not conflate them:
//  * Chromium's remote-debugging PORT (an open TCP debugging endpoint) is enabled
//    only for the explicit Developer mode setting (or the standalone
//    `RYU_BROWSER_CDP=1` override), matching the ghost-core CDP precedent's
//    opt-in posture.
//  * `webContents.debugger` is an IN-PROCESS CDP session Electron exposes with no
//    port and no external surface. That is what snapshot/click/type/scroll use, so
//    they work with the debugging port off.
//
// This entry wires the pieces together once Electron is ready: `startup.ts`
// (profile path, CDP switches), `shell-runtime.ts` (the visible window),
// `electron-tab-*.ts` (the tab manager layers), `bot-sessions.ts`,
// `session-handlers.ts` and `ipc-handlers.ts`.

import { app, Menu, type Session, safeStorage, session } from "electron";
import { resolveShellLocale, setShellLocale } from "../i18n/shell-i18n.ts";
import { BrowserActivityStore } from "./activity.ts";
import { BrowserSessionRouter } from "./bot-sessions.ts";
import { BrowserExtensionManager } from "./browser-extensions.ts";
import { BrowserStateStore } from "./browser-state-store.ts";
import {
	resolveControlPort,
	resolveControlToken,
	safeNavigationUrlResolved,
	startControlServer,
} from "./control.ts";
import { ElectronTabManager } from "./electron-tab-manager.ts";
import {
	parseUpstreamProxy,
	startGuardedSocksProxy,
} from "./guarded-socks-proxy.ts";
import { registerIpcHandlers } from "./ipc-handlers.ts";
import { removeDefaultApplicationMenu } from "./native-menu.ts";
import {
	installNavigationGuard,
	routeThroughNetworkGuard,
} from "./network-guard.ts";
import { describeCookieProtection } from "./profile-storage.ts";
import {
	installDownloadHandlers,
	installPermissionHandlers,
} from "./session-handlers.ts";
import {
	createWindow,
	emitState,
	runtime,
	setRuntime,
	setThemeTokens,
} from "./shell-runtime.ts";
import { vaultClientFromEnv } from "./vault-fill.ts";
import "./startup.ts";

export { BrowserSessionRouter } from "./bot-sessions.ts";

let botSessions: BrowserSessionRouter | null = null;
let closeNetworkGuard: (() => void) | null = null;

app
	.whenReady()
	.then(async () => {
		// On a cloud node Core hands us its credentialed proxy so tabs follow
		// "Route traffic through this computer"; a malformed value fails closed.
		const networkGuard = await startGuardedSocksProxy({
			upstream: parseUpstreamProxy(process.env.RYU_EGRESS_PROXY_URL),
		});
		closeNetworkGuard = networkGuard.close;
		const guardNetwork = (browserSession: Session): Promise<void> =>
			routeThroughNetworkGuard(browserSession, networkGuard.port);
		await guardNetwork(session.defaultSession);
		const cookieProtection = describeCookieProtection(
			process.platform,
			process.platform === "linux"
				? safeStorage.getSelectedStorageBackend()
				: null,
			safeStorage.isEncryptionAvailable()
		);
		if (!cookieProtection.protected) {
			console.warn(
				`[ryu-browser] cookies are not encrypted with an OS key: ${cookieProtection.detail}`
			);
		}
		// Core may pin the language; otherwise follow the OS until the desktop's
		// theme snapshot (`PUT /theme`, `--ryu-locale`) names the Ryu UI language.
		setShellLocale(
			resolveShellLocale([
				process.env.RYU_LOCALE,
				...app.getPreferredSystemLanguages(),
				app.getLocale(),
			])
		);
		// The shell draws its own localized menu; drop Electron's English default
		// menu bar on Windows/Linux before the window copies it.
		removeDefaultApplicationMenu(Menu, process.platform);
		const { win, strip, stripView } = createWindow();
		const store = new BrowserStateStore(
			app.getPath("userData"),
			app.getPath("downloads")
		);
		const activities = new BrowserActivityStore(() => {
			if (runtime) {
				emitState();
			}
		});
		const extensions = new BrowserExtensionManager(
			session.defaultSession,
			store
		);
		await extensions.restore();
		botSessions = new BrowserSessionRouter(
			activities,
			() => {
				if (runtime) {
					emitState();
				}
			},
			guardNetwork
		);
		session.defaultSession.setDownloadPath(
			store.getSettings().downloadDirectory
		);
		const token = resolveControlToken();
		if (!token) {
			console.warn(
				"[ryu-browser] no RYU_EXT_TOKEN/RYU_BROWSER_TOKEN set — control server is FAIL-CLOSED (all protected routes reject). Core injects RYU_EXT_TOKEN when it spawns this sidecar."
			);
		}
		const tabs = new ElectronTabManager(
			session.defaultSession,
			win,
			emitState,
			(tab) => {
				runtime?.store.addHistory(tab.url, tab.title);
			},
			(result) => strip.send("ryu-browser:find-result", result),
			activities,
			"visible"
		);
		installNavigationGuard(session.defaultSession);
		setRuntime({
			activities,
			overlayVisible: false,
			extensions,
			store,
			surface: "browser",
			strip,
			stripView,
			themeTokens: {},
			tabs,
			win,
		});
		installPermissionHandlers(session.defaultSession, store, win, true);
		installDownloadHandlers(
			session.defaultSession,
			store,
			win,
			true,
			emitState
		);
		registerIpcHandlers();
		// Start with one familiar New tab so the browser shell is useful before an agent
		// opens its first page, while the control API still supports an empty session.
		tabs.open("about:blank");
		emitState();
		startControlServer(
			{
				controlEnabled: () =>
					runtime?.store.getSettings().allowControl ?? false,
				setTheme: setThemeTokens,
				tabs,
				tabsFor: (agentId) => botSessions?.tabsFor(agentId) ?? null,
				token,
				validateNavigationUrl: safeNavigationUrlResolved,
				vault: vaultClientFromEnv(),
			},
			resolveControlPort()
		);
	})
	.catch((error) => {
		console.error("[ryu-browser] network guard initialization failed", error);
		app.quit();
	});

app.on("before-quit", () => {
	closeNetworkGuard?.();
	runtime?.store.flush();
	botSessions?.closeAll();
	botSessions = null;
});

app.on("window-all-closed", () => {
	// Keep running headless: Core manages this sidecar's lifecycle (lazy + idle-stop),
	// so closing the window must not kill the control server on non-macOS either.
	// (No-op; do not app.quit().)
});
