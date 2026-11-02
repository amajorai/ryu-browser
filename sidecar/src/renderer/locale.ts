/**
 * Keep the shell document's language in step with the shell locale: the
 * main process's starting locale (passed through the preload) and, once the
 * desktop sends its theme snapshot, the `--ryu-locale` it carries.
 */
import {
	setShellLocale,
	shellDirection,
	shellLocale,
} from "../i18n/shell-i18n.ts";

/** The part of `document.documentElement` the shell locale writes. */
export interface LocaleRoot {
	dir: string;
	lang: string;
}

/** Write `lang` and `dir` for the active shell locale onto `root`. */
export function applyDocumentLocale(root: LocaleRoot): void {
	root.lang = shellLocale();
	root.dir = shellDirection();
}

/**
 * Adopt `tag` as the shell locale and update `root`. Returns whether the
 * locale changed (the caller re-renders).
 */
export function adoptShellLocale(
	tag: string | null | undefined,
	root: LocaleRoot | undefined
): boolean {
	const changed = setShellLocale(tag);
	if (root) {
		applyDocumentLocale(root);
	}
	return changed;
}

/** The locale named by a theme snapshot, if any. */
export function themeLocale(tokens: Record<string, string>): string | null {
	const value = tokens["--ryu-locale"]?.trim();
	return value && value !== "system" ? value : null;
}
