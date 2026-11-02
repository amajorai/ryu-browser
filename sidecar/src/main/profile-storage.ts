// Where the Ryu Browser keeps its Chromium profile, and how Chromium protects the
// cookies in it.
//
// Profile: under Ryu Core the profile (cookies, Local Storage, IndexedDB, cache,
// browser-state.json and the managed-bot partition) lives in this app's plugin
// data directory (`RYU_PLUGIN_DATA_DIR/profile`), so it follows the data-dir
// layout and is removed with the app's data. A profile left at the old OS default
// location is moved there once, before Chromium opens it. Run standalone (no
// `RYU_PLUGIN_DATA_DIR`), the OS default is kept.
//
// Cookies: release builds flip Electron's `EnableCookieEncryption` fuse
// (`electron-builder.yml`), so Chromium encrypts cookie values with its os_crypt
// key: the macOS Keychain, Windows DPAPI, or on Linux the Secret Service
// (libsecret) or KWallet. Chromium's Linux auto-detection only picks a keyring on
// desktops it recognizes and otherwise uses the `basic` store, whose key is a
// constant compiled into Chromium (obfuscation, not encryption). Outside KDE we
// therefore ask for libsecret explicitly; Chromium still falls back to `basic`
// when no Secret Service is running, and `describeCookieProtection` reports that.

import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The env var Core sets to this app's plugin data directory. */
export const PLUGIN_DATA_DIR_ENV = "RYU_PLUGIN_DATA_DIR";
/** The profile's directory name inside the plugin data directory. */
export const PROFILE_DIR_NAME = "profile";

export interface ProfileLocation {
	/** A profile at the old default location to move into `path`, if any. */
	migrateFrom: string | null;
	/** The directory Chromium should use as `userData`. */
	path: string;
}

/**
 * Decide the profile directory. Pure, so it is unit-testable: `exists` reports
 * whether a path is present on disk.
 */
export function resolveProfileLocation(
	env: Record<string, string | undefined>,
	defaultUserData: string,
	exists: (path: string) => boolean
): ProfileLocation {
	const pluginDataDir = env[PLUGIN_DATA_DIR_ENV]?.trim();
	if (!pluginDataDir) {
		return { migrateFrom: null, path: defaultUserData };
	}
	const path = join(pluginDataDir, PROFILE_DIR_NAME);
	const legacy = resolve(defaultUserData);
	const migrate =
		resolve(path) !== legacy && !exists(path) && exists(defaultUserData);
	return { migrateFrom: migrate ? defaultUserData : null, path };
}

/**
 * The Chromium `--password-store` value to request on Linux, or `null` to keep
 * Chromium's own choice. KDE sessions keep auto-detection (KWallet); every other
 * Linux session asks for libsecret instead of silently getting `basic`.
 */
export function linuxPasswordStore(
	platform: NodeJS.Platform,
	env: Record<string, string | undefined>
): string | null {
	if (platform !== "linux") {
		return null;
	}
	const desktop = `${env.XDG_CURRENT_DESKTOP ?? ""}:${env.DESKTOP_SESSION ?? ""}`;
	if (desktop.toUpperCase().includes("KDE")) {
		return null;
	}
	return "gnome-libsecret";
}

/**
 * How cookies are protected at rest, from Electron's `safeStorage`: the selected
 * Linux backend (`getSelectedStorageBackend()`, `null` elsewhere) and whether
 * os_crypt has a key at all (`isEncryptionAvailable()`, after `ready`).
 */
export function describeCookieProtection(
	platform: NodeJS.Platform,
	linuxBackend: string | null,
	encryptionAvailable: boolean
): { protected: boolean; detail: string } {
	if (!encryptionAvailable) {
		return {
			detail:
				"os_crypt has no key, so Chromium stores cookie values unencrypted",
			protected: false,
		};
	}
	if (platform === "darwin") {
		return { detail: "macOS Keychain", protected: true };
	}
	if (platform === "win32") {
		return { detail: "Windows DPAPI", protected: true };
	}
	if (
		linuxBackend === null ||
		linuxBackend === "basic_text" ||
		linuxBackend === "unknown"
	) {
		return {
			detail:
				"no Secret Service or KWallet available: Chromium's basic store uses a built-in key, so cookies are only obfuscated",
			protected: false,
		};
	}
	return { detail: `Linux ${linuxBackend}`, protected: true };
}

/**
 * Move a legacy profile into place (a rename, so nothing is left behind) and
 * keep the directory owner-only. Returns the directory to use: on any failure,
 * the legacy profile stays where it is and is used as before.
 */
export function prepareProfileDirectory(location: ProfileLocation): string {
	try {
		if (location.migrateFrom) {
			mkdirSync(dirname(location.path), { mode: 0o700, recursive: true });
			renameSync(location.migrateFrom, location.path);
		}
		mkdirSync(location.path, { mode: 0o700, recursive: true });
		restrictToOwner(location.path);
		return location.path;
	} catch {
		return location.migrateFrom ?? location.path;
	}
}

/** Best-effort `0700` on a directory (no-op on Windows). */
export function restrictToOwner(path: string): void {
	if (process.platform === "win32" || !existsSync(path)) {
		return;
	}
	try {
		chmodSync(path, 0o700);
	} catch {
		// A profile on a filesystem without POSIX modes keeps its defaults.
	}
}
