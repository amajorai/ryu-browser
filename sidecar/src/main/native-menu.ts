/**
 * The shell draws its own (localized) HTML browser menu, so the native window
 * must not carry Electron's default application menu. On Windows and Linux
 * every new window copies the application menu into a native menu bar, and
 * Electron's default one is a fixed English File/Edit/View/Window/Help menu
 * whose Help items open electronjs.org. Clearing it before the first window is
 * created removes that bar.
 *
 * macOS keeps the default menu: `LSUIElement` hides the menu bar there, and
 * its Edit roles are what route Cmd+C/Cmd+V into web contents. On Windows and
 * Linux Chromium handles the editing shortcuts itself, and the shell's own menu
 * already offers reload and developer tools.
 */

/** The `Menu` surface this module uses, so tests can pass a fake. */
export interface ApplicationMenuHost {
	setApplicationMenu(menu: null): void;
}

export function shouldRemoveDefaultMenu(platform: NodeJS.Platform): boolean {
	return platform === "win32" || platform === "linux";
}

/** Clears the default application menu on Windows and Linux. */
export function removeDefaultApplicationMenu(
	menu: ApplicationMenuHost,
	platform: NodeJS.Platform
): boolean {
	if (!shouldRemoveDefaultMenu(platform)) {
		return false;
	}
	menu.setApplicationMenu(null);
	return true;
}
