/**
 * How the main process hands the shell renderer its starting locale: a
 * `--ryu-shell-locale=<tag>` entry in `webPreferences.additionalArguments`,
 * which the sandboxed preload reads from `process.argv`. Kept apart from
 * `shell-i18n.ts` so the preload bundle does not carry the catalog.
 */
export const SHELL_LOCALE_ARGUMENT = "--ryu-shell-locale=";

/** The `--ryu-shell-locale` value among `argv`, or null. */
export function shellLocaleFromArgv(argv: readonly string[]): string | null {
	const entry = argv.find((value) => value.startsWith(SHELL_LOCALE_ARGUMENT));
	const tag = entry?.slice(SHELL_LOCALE_ARGUMENT.length).trim();
	return tag && /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/u.test(tag)
		? tag
		: null;
}
