// Coded errors the main process hands the shell renderer.
//
// `ipcRenderer.invoke` rejects with a plain `Error` whose message is Electron's
// English wrapper around `String(error)`: "Error invoking remote method
// '<channel>': <name>: <message>". The renderer must not show that text, so a
// main-side failure the user can cause and fix carries a stable code in its
// `name`, which survives the IPC hop. The English `message` stays as it was, so
// the loopback control API and logs read the same as before. The renderer maps
// a code to its own localized sentence (`renderer/ipc-error.ts`) and shows the
// caller's localized fallback for anything uncoded.

export const SHELL_ERROR_CODES = [
	"extension-folder-required",
	"navigation-private-host",
	"navigation-unsupported-url",
	"url-required",
] as const;

export type ShellErrorCode = (typeof SHELL_ERROR_CODES)[number];

const NAME_PREFIX = "RyuBrowserError:";
const CODE_PATTERN = /RyuBrowserError:([a-z-]+)/u;

/** An `Error` whose `name` carries `code` across the IPC boundary. */
export function shellError(code: ShellErrorCode, message: string): Error {
	const error = new Error(message);
	error.name = `${NAME_PREFIX}${code}`;
	return error;
}

function isShellErrorCode(value: string): value is ShellErrorCode {
	return (SHELL_ERROR_CODES as readonly string[]).includes(value);
}

/** The code a main-side or IPC-wrapped error carries, or null. */
export function shellErrorCode(error: unknown): ShellErrorCode | null {
	if (!(error instanceof Error)) {
		return null;
	}
	const match = CODE_PATTERN.exec(`${error.name} ${error.message}`);
	const code = match?.[1];
	return code && isShellErrorCode(code) ? code : null;
}

/**
 * Tag the navigation guard's refusals (`control.ts` `safeNavigationUrl`) for
 * the shell; any other error passes through unchanged.
 */
export function codedNavigationError(error: unknown): unknown {
	if (!(error instanceof Error) || shellErrorCode(error)) {
		return error;
	}
	if (error.message.includes("cannot target private or local hosts")) {
		return shellError("navigation-private-host", error.message);
	}
	if (
		error.message.includes("requires a valid web URL") ||
		error.message.includes("only allows http, https, or about:blank")
	) {
		return shellError("navigation-unsupported-url", error.message);
	}
	return error;
}
