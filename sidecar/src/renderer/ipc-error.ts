/**
 * What a shell toast says when a bridge call fails.
 *
 * A rejected `ipcRenderer.invoke` arrives as Electron's English "Error invoking
 * remote method …" text, and Chromium's own failures (`loadExtension`, …) are
 * English too. Neither is shown: a coded main-side error (`main/shell-error.ts`)
 * maps to its localized sentence, a renderer-side `LocalizedError` keeps its
 * already-translated message, and everything else shows the caller's localized
 * fallback.
 */
import { tl } from "../i18n/shell-i18n.ts";
import { type ShellErrorCode, shellErrorCode } from "../main/shell-error.ts";

/** A renderer-thrown error whose message is already in the shell language. */
export class LocalizedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalizedError";
	}
}

function codedMessage(code: ShellErrorCode): string {
	switch (code) {
		case "extension-folder-required":
			return tl("Choose an unpacked extension folder");
		case "navigation-private-host":
			return tl("Ryu Browser can't open private or local network addresses.");
		case "navigation-unsupported-url":
			return tl("Enter a web address that starts with http or https.");
		case "url-required":
			return tl("Enter a URL");
		default:
			return code satisfies never;
	}
}

/** The localized toast for `error`; `fallback` must already be localized. */
export function toastMessageFor(error: unknown, fallback: string): string {
	if (error instanceof LocalizedError) {
		return error.message;
	}
	const code = shellErrorCode(error);
	return code ? codedMessage(code) : fallback;
}
