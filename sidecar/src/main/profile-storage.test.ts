import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
	describeCookieProtection,
	linuxPasswordStore,
	resolveProfileLocation,
} from "./profile-storage.ts";

const DEFAULT = "/home/me/.config/Ryu Browser";

describe("profile location", () => {
	it("keeps the OS default when not started by Core", () => {
		expect(resolveProfileLocation({}, DEFAULT, () => true)).toEqual({
			migrateFrom: null,
			path: DEFAULT,
		});
	});

	it("moves a legacy profile into the plugin data directory once", () => {
		const dataDir = "/data/plugin-data/@ryu+browser";
		const target = join(dataDir, "profile");
		const fresh = resolveProfileLocation(
			{ RYU_PLUGIN_DATA_DIR: dataDir },
			DEFAULT,
			(path) => path === DEFAULT
		);
		expect(fresh).toEqual({ migrateFrom: DEFAULT, path: target });
		// Already moved: never clobber the profile in place.
		const moved = resolveProfileLocation(
			{ RYU_PLUGIN_DATA_DIR: dataDir },
			DEFAULT,
			() => true
		);
		expect(moved).toEqual({ migrateFrom: null, path: target });
	});
});

describe("cookie protection", () => {
	it("asks for libsecret outside KDE and keeps KWallet detection on KDE", () => {
		expect(linuxPasswordStore("linux", { XDG_CURRENT_DESKTOP: "sway" })).toBe(
			"gnome-libsecret"
		);
		expect(linuxPasswordStore("linux", {})).toBe("gnome-libsecret");
		expect(linuxPasswordStore("linux", { XDG_CURRENT_DESKTOP: "KDE" })).toBe(
			null
		);
		expect(linuxPasswordStore("darwin", {})).toBe(null);
		expect(linuxPasswordStore("win32", {})).toBe(null);
	});

	it("never reports the basic store or a missing key as protected", () => {
		expect(
			describeCookieProtection("linux", "basic_text", true).protected
		).toBe(false);
		expect(describeCookieProtection("linux", "unknown", true).protected).toBe(
			false
		);
		expect(
			describeCookieProtection("linux", "gnome_libsecret", true).protected
		).toBe(true);
		expect(describeCookieProtection("darwin", null, false).protected).toBe(
			false
		);
		expect(describeCookieProtection("win32", null, true).protected).toBe(true);
	});
});
