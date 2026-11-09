/**
 * The language of Ryu Browser's own window: the shell renderer's chrome and
 * the main process's native dialogs.
 *
 * The browser is a standalone satellite, so it carries its own slice of the
 * official catalog instead of importing `@ryu/i18n`:
 * `shell-catalog.generated.json` is `{ <locale>: { <English source>:
 * <translation> } }` for exactly the `tl("…")` sources under `src/`, written by
 * `scripts/sync-browser-shell-catalog.mjs`. A sentence the catalog lacks stays
 * English.
 *
 * Each process holds its own active locale: the main process starts from
 * `RYU_LOCALE` or the OS language and passes it to the shell renderer, and
 * both follow the `--ryu-locale` token the desktop's theme snapshot carries.
 */

import { formatMessage, type MessageValues } from "./message-format.ts";
import catalogs from "./shell-catalog.generated.json";

const CATALOGS: Readonly<Record<string, Readonly<Record<string, string>>>> =
	catalogs;
const ENGLISH = "en";
const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur"]);

let activeLocale = ENGLISH;
const listeners = new Set<(locale: string) => void>();

/** The catalog locale whose language and script match `tag`, `en`, or null. */
export function catalogLocaleFor(tag: string): string | null {
	const cleaned = tag.split(/[.@]/u)[0]?.replaceAll("_", "-").trim() ?? "";
	if (!cleaned || cleaned === "C" || cleaned === "POSIX") {
		return null;
	}
	if (Object.hasOwn(CATALOGS, cleaned)) {
		return cleaned;
	}
	try {
		const wanted = new Intl.Locale(cleaned).maximize();
		if (wanted.language === ENGLISH) {
			return ENGLISH;
		}
		for (const candidate of Object.keys(CATALOGS)) {
			const official = new Intl.Locale(candidate).maximize();
			if (
				official.language === wanted.language &&
				official.script === wanted.script
			) {
				return candidate;
			}
		}
	} catch {
		// An invalid tag matches no catalog.
	}
	return null;
}

/** The first of `tags` a catalog (or English) covers, else English. */
export function resolveShellLocale(
	tags: readonly (string | null | undefined)[]
): string {
	for (const tag of tags) {
		const match = tag ? catalogLocaleFor(tag) : null;
		if (match) {
			return match;
		}
	}
	return ENGLISH;
}

/** The active shell locale (`en` or a catalog key). */
export function shellLocale(): string {
	return activeLocale;
}

/** Text direction of `locale` (the active one by default). */
export function shellDirection(locale = activeLocale): "ltr" | "rtl" {
	try {
		return RTL_LANGUAGES.has(new Intl.Locale(locale).language) ? "rtl" : "ltr";
	} catch {
		return "ltr";
	}
}

/**
 * Switch the active locale to the best match for `tag`. A tag no catalog
 * covers (and an empty or `system` one) leaves the current locale alone.
 * Returns whether the locale changed.
 */
export function setShellLocale(tag: string | null | undefined): boolean {
	const next = tag && tag !== "system" ? catalogLocaleFor(tag) : null;
	if (!next || next === activeLocale) {
		return false;
	}
	activeLocale = next;
	for (const listener of listeners) {
		listener(next);
	}
	return true;
}

/** Run `listener` whenever the active locale changes; returns an unsubscribe. */
export function onShellLocaleChange(
	listener: (locale: string) => void
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Translate an English source into the active locale and fill its ICU
 * arguments. Always pass a string literal: the catalog generator and the
 * extractor read the first argument.
 */
export function tl(source: string, values?: MessageValues): string {
	const message = CATALOGS[activeLocale]?.[source] ?? source;
	return formatMessage(message, values, activeLocale);
}
