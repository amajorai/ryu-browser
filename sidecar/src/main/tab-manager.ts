// Tab manager abstraction for the Ryu Browser sidecar.
//
// The control server (`control.ts`) depends only on the `TabManager` INTERFACE, so
// its routing/auth is unit-tested against a fake with no Electron present. The real
// `ElectronTabManager` (wired in `index.ts`) backs each tab with a modern
// `WebContentsView` (Electron ≥30) attached to the app window's content view, and
// drives snapshot/click/type/scroll over that view's CDP session
// (`webContents.debugger`).

export interface TabInfo {
	id: string;
	title: string;
	url: string;
}

/** The four directions `browser__scroll` can be asked for. */
export type ScrollDirection = "down" | "left" | "right" | "up";

/**
 * One element of an accessibility snapshot.
 *
 * `ref` is the STABLE handle the later calls take (`@e1`, `@e2`, …). It is minted by
 * the snapshot and resolves, inside the sidecar, to the element's CDP
 * `backendDOMNodeId` — deliberately NOT the `AXNodeId`, whose stability the protocol
 * only promises "between method calls" while the accessibility domain is enabled.
 * A ref stays valid until the next snapshot of that tab or until the tab navigates.
 */
export interface SnapshotElement {
	/** Nesting level in the accessibility tree, counted over EMITTED nodes only. */
	depth: number;
	/** Accessible name (visible label / text), truncated. Absent when unnamed. */
	name?: string;
	/** Whitelisted accessibility properties (checked/disabled/expanded/…). */
	props?: Record<string, boolean | number | string>;
	/** Stable element reference, e.g. `"@e3"`. */
	ref: string;
	/** Accessibility role, e.g. `"button"`, `"link"`, `"StaticText"`. */
	role: string;
	/** Current value for inputs/sliders. Absent when the node has none. */
	value?: string;
}

export interface SnapshotResult {
	elements: SnapshotElement[];
	/** Identifies this snapshot generation; a later snapshot invalidates the refs. */
	snapshot_id: string;
	tab: TabInfo;
	/** True when the tree was larger than the node cap and elements were dropped. */
	truncated: boolean;
}

/** Result of a synthetic-input action. `x`/`y` are viewport CSS pixels. */
export interface ActionResult {
	ok: true;
	tab: TabInfo;
	x?: number;
	y?: number;
}

/**
 * A caller-fixable failure: the ref is unknown to the current snapshot, or the node
 * it names is no longer laid out. Distinguished from a transport/CDP fault so the
 * control server can answer 400 ("re-run snapshot") instead of a blind 500.
 */
export class RefError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RefError";
	}
}

/**
 * The capability surface the control server drives. Kept transport-free (plain
 * values / promises) so it can be faked in tests and, later, backed by a different
 * engine without touching the HTTP layer.
 *
 * Every method that names a tab takes a CONCRETE id; resolving "no tab given ⇒ the
 * active one" is the control server's job, using [`activeId`], so the fallback is
 * testable without Electron.
 */
export interface TabManager {
	/** Id of the tab currently laid out in the window, or null when there are none. */
	activeId(): string | null;
	/**
	 * Click the element `ref` names in tab `id`. Returns null when the tab is gone;
	 * throws [`RefError`] when the ref is unknown or its element has no layout box.
	 */
	click(id: string, ref: string): Promise<ActionResult | null>;
	/** Close tab `id`; returns false when no such tab exists. */
	close(id: string): boolean;
	/** Evaluate `expression` in tab `id`'s web contents (PRIVILEGED). */
	eval(id: string, expression: string): Promise<unknown>;
	list(): TabInfo[];
	/** Navigate tab `id` to `url`; returns the updated tab or null when absent. */
	navigate(id: string, url: string): TabInfo | null;
	/** Open a new tab at `url` and return it. */
	open(url: string): TabInfo;
	/** Base64 PNG of tab `id`'s viewport, or null when absent. */
	screenshot(id: string): Promise<string | null>;
	/**
	 * Scroll tab `id`'s viewport. `amount` is a CSS-pixel distance; omitted means a
	 * viewport-proportional default. Returns null when the tab is gone.
	 */
	scroll(
		id: string,
		direction: ScrollDirection,
		amount?: number
	): Promise<ActionResult | null>;
	/**
	 * Capture tab `id`'s accessibility tree and mint fresh element refs, replacing
	 * that tab's previous ref set. Returns null when the tab is gone.
	 */
	snapshot(id: string): Promise<SnapshotResult | null>;
	/** Current document title of tab `id`, or null when absent. */
	title(id: string): string | null;
	/**
	 * Focus the element `ref` names in tab `id` and insert `text` at its caret,
	 * optionally pressing Enter.
	 *
	 * Insertion APPENDS by default — it does not clear an existing value — so pass
	 * `replace` to overwrite the field instead. Without it a caller assuming
	 * replace-semantics double-fills a search box that already has a value.
	 *
	 * Throws [`RefError`] for a bad ref, and also when the ref resolves to
	 * something that cannot take text: focusing succeeds on plenty of elements
	 * (a link, a `tabindex` div, a read-only input) that then swallow the
	 * insertion, which would otherwise report success for a no-op.
	 * Returns null when the tab is gone.
	 */
	type(
		id: string,
		ref: string,
		text: string,
		submit: boolean,
		replace?: boolean
	): Promise<ActionResult | null>;
}
