// The last Ryu UI language the desktop pushed (`PUT /theme`, `--ryu-locale`),
// kept beside the browser profile so a cold start opens in that language.
//
// Core does not pin `RYU_LOCALE` for sidecars, and the theme push only happens
// while Desktop's browser panel is mounted. Without this file an agent that
// launches (or restarts) the browser gets OS-language chrome until the panel
// next mounts. The file lives in Chromium's `userData` directory, which follows
// `RYU_PLUGIN_DATA_DIR` (`profile-storage.ts`).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const FILE_NAME = "shell-locale.json";
const storedLocaleSchema = z.object({
	locale: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_.@-]+$/u),
});

let directory: string | null = null;
let lastWritten: string | null = null;

/** Where `persistShellLocale` writes; `index.ts` sets it once at startup. */
export function setLocaleStoreDirectory(path: string): void {
	directory = path;
	lastWritten = readStoredShellLocale(path);
}

/** The persisted locale tag under `dir`, or null when absent or unreadable. */
export function readStoredShellLocale(dir: string): string | null {
	try {
		const parsed = storedLocaleSchema.safeParse(
			JSON.parse(readFileSync(join(dir, FILE_NAME), "utf8"))
		);
		return parsed.success ? parsed.data.locale : null;
	} catch {
		return null;
	}
}

/** Write `locale` under `dir`; a missing or malformed tag writes nothing. */
export function writeStoredShellLocale(dir: string, locale: unknown): boolean {
	const parsed = storedLocaleSchema.safeParse({ locale });
	if (!parsed.success) {
		return false;
	}
	try {
		mkdirSync(dir, { mode: 0o700, recursive: true });
		const target = join(dir, FILE_NAME);
		const temporary = `${target}.tmp`;
		writeFileSync(
			temporary,
			`${JSON.stringify({ locale: parsed.data.locale })}\n`,
			{ mode: 0o600 }
		);
		renameSync(temporary, target);
		return true;
	} catch {
		// Persisting is a convenience: the next theme push sets the language anyway.
		return false;
	}
}

/** Persist the theme's locale when it changed since the last write. */
export function persistShellLocale(locale: string | undefined): void {
	if (!(directory && locale) || locale === lastWritten) {
		return;
	}
	if (writeStoredShellLocale(directory, locale)) {
		lastWritten = locale;
	}
}

/**
 * The startup preference order: a Core-pinned `RYU_LOCALE`, then the last Ryu
 * language the desktop pushed, then the OS languages.
 */
export function startupLocaleCandidates(input: {
	envLocale: string | undefined;
	storedLocale: string | null;
	systemLocales: readonly string[];
}): (string | null | undefined)[] {
	return [input.envLocale, input.storedLocale, ...input.systemLocales];
}
