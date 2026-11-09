// Chromium's own UI language (`--lang`) for Ryu Browser on Windows and Linux.
//
// Chromium draws form-validation bubbles, date/time/select pickers and media
// controls itself, and derives the default `Accept-Language` from its UI
// language, which follows the OS unless `--lang` names another one. The switch
// only works before `app` is ready, so it is chosen from what is known at
// startup: a Core-pinned `RYU_LOCALE`, then the last Ryu UI language the
// desktop pushed (`locale-store.ts`). With neither, Chromium keeps following
// the OS. A language change applies on the next browser launch, the same as
// the desktop's WebView2 (`apps/desktop/src-tauri/src/webview_locale.rs`).
// macOS ignores `--lang` (it reads the app's preferred languages instead), so
// nothing is appended there.

import { catalogLocaleFor } from "../i18n/shell-i18n.ts";
import { readStoredShellLocale } from "./locale-store.ts";

/** The part of Electron's `app.commandLine` this module uses. */
export interface CommandLineSwitches {
	appendSwitch(name: string, value?: string): void;
}

const LANG_PLATFORMS = new Set<string>(["win32", "linux"]);

/** English as a locale Chromium ships (`en-GB` or `en-US`). */
function englishTag(tag: string): string {
	try {
		return new Intl.Locale(tag.replaceAll("_", "-")).region === "GB"
			? "en-GB"
			: "en-US";
	} catch {
		return "en-US";
	}
}

/**
 * The Chromium locale for the first usable candidate, or null. Candidates are
 * matched to the shell's official catalogs (`pt_BR` → `pt-BR`, `zh` →
 * `zh-CN`); `system`, blank and unsupported tags are skipped.
 */
export function chromiumLangTag(
	candidates: readonly (string | null | undefined)[]
): string | null {
	for (const candidate of candidates) {
		const tag = candidate?.trim() ?? "";
		if (!tag || tag.toLowerCase() === "system") {
			continue;
		}
		const match = catalogLocaleFor(tag);
		if (match === "en") {
			return englishTag(tag);
		}
		if (match) {
			return match;
		}
	}
	return null;
}

/**
 * Append `--lang` for the Ryu UI language on Windows and Linux. `userDataDir`
 * must already be the browser profile directory (set by `startup.ts`), since
 * the stored locale lives there. Returns the tag appended, or null.
 */
export function applyChromiumLang(input: {
	commandLine: CommandLineSwitches;
	envLocale: string | undefined;
	platform: string;
	userDataDir: string;
}): string | null {
	if (!LANG_PLATFORMS.has(input.platform)) {
		return null;
	}
	const tag = chromiumLangTag([
		input.envLocale,
		readStoredShellLocale(input.userDataDir),
	]);
	if (tag) {
		input.commandLine.appendSwitch("lang", tag);
	}
	return tag;
}
