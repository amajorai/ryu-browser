// Tab manager abstraction for the Ryu Browser sidecar.
//
// The control server (`control.ts`) depends only on the `TabManager` INTERFACE, so
// its routing/auth is unit-tested against a fake with no Electron present. The real
// `ElectronTabManager` (wired in `index.ts`) backs each tab with a modern
// `WebContentsView` (Electron ≥30) attached to the app window's content view.

export interface TabInfo {
	id: string;
	url: string;
	title: string;
}

/**
 * The capability surface the control server drives. Kept transport-free (plain
 * values / promises) so it can be faked in tests and, later, backed by a different
 * engine without touching the HTTP layer.
 */
export interface TabManager {
	list(): TabInfo[];
	/** Open a new tab at `url` and return it. */
	open(url: string): TabInfo;
	/** Close tab `id`; returns false when no such tab exists. */
	close(id: string): boolean;
	/** Navigate tab `id` to `url`; returns the updated tab or null when absent. */
	navigate(id: string, url: string): TabInfo | null;
	/** Base64 PNG of tab `id`'s viewport, or null when absent. */
	screenshot(id: string): Promise<string | null>;
	/** Evaluate `expression` in tab `id`'s web contents (PRIVILEGED). */
	eval(id: string, expression: string): Promise<unknown>;
	/** Current document title of tab `id`, or null when absent. */
	title(id: string): string | null;
}
