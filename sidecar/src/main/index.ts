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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SEAL_ENV_VARS } from "@ryu/sidecar-runtime/seal";
import { app, Menu, safeStorage, session } from "electron";
import { resolveShellLocale, setShellLocale } from "../i18n/shell-i18n.ts";
import { BrowserActivityStore } from "./activity.ts";
import { BotLiveViews } from "./bot-live-view.ts";
import {
	type BotLaneNetwork,
	BrowserSessionRouter,
	installNavigationGuard,
	routeThroughNetworkGuard,
} from "./bot-session-router.ts";
import { BrowserExtensionManager } from "./browser-extensions.ts";
import {
	installDownloadHandlers,
	installPermissionHandlers,
} from "./browser-handlers.ts";
import { registerIpcHandlers } from "./browser-ipc.ts";
import { browserPersistedCdpSchema } from "./browser-records.ts";
import {
	createWindow,
	emitState,
	setThemeTokens,
	sidecarState,
} from "./browser-shell.ts";
import { BrowserStateStore } from "./browser-state-store.ts";
import {
	assertNoProxyBypass,
	disableSecureDns,
} from "./chromium-egress-hardening.ts";
import { applyChromiumLang } from "./chromium-lang.ts";
import { laneLiveViewDeps } from "./control-live-view.ts";
import { startControlServer } from "./control-server.ts";
import { ElectronTabManager } from "./electron-tab-manager.ts";
import {
	parseUpstreamProxy,
	startGuardedSocksProxy,
} from "./guarded-socks-proxy.ts";
import {
	readStoredShellLocale,
	setLocaleStoreDirectory,
	startupLocaleCandidates,
} from "./locale-store.ts";
import { removeDefaultApplicationMenu } from "./native-menu.ts";
import {
	resolveControlPort,
	resolveControlToken,
	safeNavigationUrlResolved,
} from "./navigation-safety.ts";
import {
	describeCookieProtection,
	linuxPasswordStore,
	prepareProfileDirectory,
	resolveProfileLocation,
} from "./profile-storage.ts";
import { vaultClientFromEnv } from "./vault-fill.ts";

function resolveRemoteCdpEnabled(): boolean {
	const override = process.env.RYU_BROWSER_CDP?.trim();
	if (override) {
		return override === "1";
	}
	try {
		const persisted = JSON.parse(
			readFileSync(join(app.getPath("userData"), "browser-state.json"), "utf8")
		);
		return browserPersistedCdpSchema.safeParse(persisted).success;
	} catch {
		return false;
	}
}

// The owner's read-only Bot-lane live views. A view nobody reads is stopped
// even when no further frame request arrives to sweep it.
const liveViews = new BotLiveViews();
setInterval(() => {
	liveViews.sweep().catch(() => undefined);
}, 5000).unref();

// This app seals nothing itself and does not declare `crypto:seal`, so Core
// delivers it no sealing subkey. Drop any key material anyway (a hand-started
// run may carry `RYU_MASTER_KEY`) so no renderer, utility process or extension
// inherits it.
for (const name of SEAL_ENV_VARS) {
	delete process.env[name];
}

// Before anything reads `userData` (the CDP preflight below) or Chromium opens
// it: keep the profile in this app's plugin data directory, and on Linux ask
// Chromium for a real keyring so encrypted cookies are not keyed by its built-in
// constant (see `profile-storage.ts`).
app.setPath(
	"userData",
	prepareProfileDirectory(
		resolveProfileLocation(process.env, app.getPath("userData"), existsSync)
	)
);
const passwordStore = linuxPasswordStore(process.platform, process.env);
if (passwordStore) {
	app.commandLine.appendSwitch("password-store", passwordStore);
}
// Chromium's own controls follow the Ryu UI language (Windows/Linux `--lang`).
applyChromiumLang({
	commandLine: app.commandLine,
	envLocale: process.env.RYU_LOCALE,
	platform: process.platform,
	userDataDir: app.getPath("userData"),
});

// Opt-in CDP. Must be set before `app` is ready. The persisted setting is read
// before startup so the Developer mode toggle is effective after a restart.
const remoteCdpEnabled = resolveRemoteCdpEnabled();
sidecarState.remoteCdpEnabled = remoteCdpEnabled;
if (remoteCdpEnabled) {
	app.commandLine.appendSwitch("remote-debugging-port", "9222");
	app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

let closeNetworkGuard: (() => void) | null = null;

app
	.whenReady()
	.then(async () => {
		// On a cloud node Core hands us its credentialed proxy so tabs follow
		// "Route traffic through this computer"; a malformed value fails closed.
		const upstream = parseUpstreamProxy(process.env.RYU_EGRESS_PROXY_URL);
		// Names are resolved where the guarded proxy screens them, never by
		// Chromium's own DNS-over-HTTPS client.
		disableSecureDns(app);
		const networkGuard = await startGuardedSocksProxy({ upstream });
		closeNetworkGuard = networkGuard.close;
		await routeThroughNetworkGuard(session.defaultSession, networkGuard.port);
		// Each Bot lane gets its own guarded proxy so Core's per-lane egress
		// allowlist can be enforced on that lane's traffic alone.
		const laneNetwork: BotLaneNetwork = {
			assertNoBypass: () => assertNoProxyBypass(app.commandLine),
			route: routeThroughNetworkGuard,
			startProxy: (allowDestination) =>
				startGuardedSocksProxy({ allowDestination, upstream }),
		};
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
		// Core may pin the language; otherwise use the last Ryu UI language the
		// desktop's theme snapshot (`PUT /theme`, `--ryu-locale`) named, then the OS.
		const localeDirectory = app.getPath("userData");
		setLocaleStoreDirectory(localeDirectory);
		setShellLocale(
			resolveShellLocale(
				startupLocaleCandidates({
					envLocale: process.env.RYU_LOCALE,
					storedLocale: readStoredShellLocale(localeDirectory),
					systemLocales: [
						...app.getPreferredSystemLanguages(),
						app.getLocale(),
					],
				})
			)
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
			if (sidecarState.runtime) {
				emitState();
			}
		});
		const extensions = new BrowserExtensionManager(
			session.defaultSession,
			store
		);
		await extensions.restore();
		sidecarState.botSessions = new BrowserSessionRouter(
			activities,
			() => {
				if (sidecarState.runtime) {
					emitState();
				}
			},
			laneNetwork
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
				sidecarState.runtime?.store.addHistory(tab.url, tab.title);
			},
			(result) => strip.send("ryu-browser:find-result", result),
			activities,
			"visible"
		);
		installNavigationGuard(session.defaultSession);
		sidecarState.runtime = {
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
		};
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
					sidecarState.runtime?.store.getSettings().allowControl ?? false,
				liveView: laneLiveViewDeps(() => sidecarState.botSessions, liveViews),
				profileLanes: () => sidecarState.botSessions,
				setTheme: setThemeTokens,
				tabs,
				tabsFor: (agentId, egressAllowlist) =>
					sidecarState.botSessions?.tabsFor(agentId, egressAllowlist) ?? null,
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
	sidecarState.runtime?.store.flush();
	liveViews.stopAll();
	sidecarState.botSessions?.closeAll();
	sidecarState.botSessions = null;
});

app.on("window-all-closed", () => {
	// Keep running headless: Core manages this sidecar's lifecycle (lazy + idle-stop),
	// so closing the window must not kill the control server on non-macOS either.
	// (No-op; do not app.quit().)
});
