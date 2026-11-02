// Process setup that must run before Electron is ready: scrub sealing key
// material, move `userData` into the plugin data directory, pick the Linux
// password store, and switch on the opt-in remote-debugging port.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SEAL_ENV_VARS } from "@ryu/sidecar-runtime/seal";
import { app } from "electron";
import { browserPersistedCdpSchema } from "./browser-records.ts";
import {
	linuxPasswordStore,
	prepareProfileDirectory,
	resolveProfileLocation,
} from "./profile-storage.ts";

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

// Opt-in CDP. Must be set before `app` is ready. The persisted setting is read
// before startup so the Developer mode toggle is effective after a restart.
export const remoteCdpEnabled = resolveRemoteCdpEnabled();
if (remoteCdpEnabled) {
	app.commandLine.appendSwitch("remote-debugging-port", "9222");
	app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
