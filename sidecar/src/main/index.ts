// Ryu Browser sidecar — Electron main process.
//
// A real-Chromium browser Core spawns as a `local` manifest sidecar. Each tab is a
// modern `WebContentsView` (Electron ≥30) attached under a thin tab-strip renderer.
// The loopback control server (`control.ts`) is the only external surface; the
// window itself is incidental (window-choreography polish is a followup).
//
// CDP, two independent things — do not conflate them:
//  * Chromium's remote-debugging PORT (an open TCP debugging endpoint) is enabled
//    ONLY when `RYU_BROWSER_CDP=1` (off by default), matching the ghost-core CDP
//    precedent's opt-in posture.
//  * `webContents.debugger` is an IN-PROCESS CDP session Electron exposes with no
//    port and no external surface. That is what snapshot/click/type/scroll use, so
//    they work with the debugging port off.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	app,
	BaseWindow,
	ipcMain,
	type WebContents,
	WebContentsView,
} from "electron";
import {
	type AXNodeLike,
	buildSnapshot,
	quadCenter,
	scrollDelta,
} from "./ax-snapshot.ts";
import {
	resolveControlPort,
	resolveControlToken,
	startControlServer,
} from "./control.ts";
import {
	type ActionResult,
	RefError,
	type ScrollDirection,
	type SnapshotResult,
	type TabInfo,
	type TabManager,
} from "./tab-manager.ts";

// Opt-in CDP. Must be set before `app` is ready.
if ((process.env.RYU_BROWSER_CDP ?? "").trim() === "1") {
	app.commandLine.appendSwitch("remote-debugging-port", "9222");
	app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

const TAB_STRIP_HEIGHT = 40;
/** CDP version to attach `webContents.debugger` with. */
const CDP_PROTOCOL_VERSION = "1.3";
/** Fallback viewport when `Page.getLayoutMetrics` reports nothing usable. */
const FALLBACK_VIEWPORT = { height: 800, width: 1200 };
/** `Enter`, for `submit: true`. */
const ENTER_KEY = {
	code: "Enter",
	key: "Enter",
	nativeVirtualKeyCode: 13,
	windowsVirtualKeyCode: 13,
};
/** `Delete`, for `replace: true` with empty text (i.e. "clear this field"). */
const DELETE_KEY = {
	code: "Delete",
	key: "Delete",
	nativeVirtualKeyCode: 46,
	windowsVirtualKeyCode: 46,
};

interface LiveTab {
	id: string;
	/** Element ref (`"@e1"`) → CDP `backendDOMNodeId`, minted by the last snapshot. */
	refs: Map<string, number>;
	/** Id of the last snapshot; cleared refs mean the caller must snapshot again. */
	snapshotId: string | null;
	view: WebContentsView;
}

/**
 * Electron-backed tab manager: each tab is a `WebContentsView` laid out below the
 * tab-strip renderer. Implements the same `TabManager` interface the control server
 * and its tests share.
 */
class ElectronTabManager implements TabManager {
	private readonly tabs: LiveTab[] = [];
	private active: string | null = null;

	constructor(
		private readonly win: BaseWindow,
		private readonly onChange: () => void
	) {
		win.on("resize", () => this.layout());
	}

	private layout(): void {
		const [width, height] = this.win.getContentSize();
		for (const t of this.tabs) {
			const visible = t.id === this.active;
			t.view.setBounds(
				visible
					? {
							x: 0,
							y: TAB_STRIP_HEIGHT,
							width,
							height: height - TAB_STRIP_HEIGHT,
						}
					: { x: 0, y: 0, width: 0, height: 0 }
			);
		}
	}

	private info(t: LiveTab): TabInfo {
		return {
			id: t.id,
			url: t.view.webContents.getURL(),
			title: t.view.webContents.getTitle(),
		};
	}

	private find(id: string): LiveTab | undefined {
		return this.tabs.find((t) => t.id === id);
	}

	list(): TabInfo[] {
		return this.tabs.map((t) => this.info(t));
	}

	activeId(): string | null {
		return this.active;
	}

	open(url: string): TabInfo {
		const view = new WebContentsView({
			webPreferences: { contextIsolation: true, nodeIntegration: false },
		});
		const tab: LiveTab = {
			id: randomUUID(),
			refs: new Map(),
			snapshotId: null,
			view,
		};
		this.tabs.push(tab);
		this.win.contentView.addChildView(view);
		this.active = tab.id;
		view.webContents.loadURL(url).catch(() => undefined);
		view.webContents.on("page-title-updated", () => this.onChange());
		// A committed main-frame navigation destroys every node the last snapshot
		// referenced. Dropping the map turns a stale ref into an explicit
		// "unknown element ref" (400, re-run snapshot) instead of a `backendNodeId`
		// that either errors deep in CDP or, worse, resolves to an unrelated node in
		// the new document.
		view.webContents.on("did-navigate", () => {
			tab.refs.clear();
			tab.snapshotId = null;
		});
		this.layout();
		this.onChange();
		return this.info(tab);
	}

	close(id: string): boolean {
		const idx = this.tabs.findIndex((t) => t.id === id);
		if (idx < 0) {
			return false;
		}
		const [tab] = this.tabs.splice(idx, 1);
		this.win.contentView.removeChildView(tab.view);
		// Detach before the contents go away so the CDP session is released even if
		// the tab is reopened at the same address later.
		try {
			if (tab.view.webContents.debugger.isAttached()) {
				tab.view.webContents.debugger.detach();
			}
		} catch {
			// Already gone; closing is still the outcome the caller asked for.
		}
		tab.view.webContents.close();
		if (this.active === id) {
			this.active = this.tabs.at(-1)?.id ?? null;
		}
		this.layout();
		this.onChange();
		return true;
	}

	navigate(id: string, url: string): TabInfo | null {
		const tab = this.find(id);
		if (!tab) {
			return null;
		}
		this.active = id;
		tab.view.webContents.loadURL(url).catch(() => undefined);
		this.layout();
		this.onChange();
		return this.info(tab);
	}

	async screenshot(id: string): Promise<string | null> {
		const tab = this.find(id);
		if (!tab) {
			return null;
		}
		const image = await tab.view.webContents.capturePage();
		return image.toPNG().toString("base64");
	}

	eval(id: string, expression: string): Promise<unknown> {
		const tab = this.find(id);
		if (!tab) {
			return Promise.reject(new Error("no such tab"));
		}
		// PRIVILEGED: Chromium's own JS evaluation in the tab's isolated web contents.
		// Grant-gated (`browser:control`) + bearer-authed + loopback-only upstream.
		return tab.view.webContents.executeJavaScript(expression, true);
	}

	// ── CDP-backed control (snapshot / click / type / scroll) ────────────────────
	//
	// All four go through `focusForControl`, which makes the target tab the ACTIVE
	// one before any CDP call. That is not cosmetic: an inactive tab's
	// `WebContentsView` is laid out at `{0,0,0,0}`, so `DOM.getBoxModel` returns a
	// degenerate rect and `Input.dispatchMouseEvent` hit-tests against a 0×0 region —
	// input that silently lands nowhere. Focusing first is what makes an explicit
	// `tab_id` behave the same as the active-tab default.

	private focusForControl(id: string): LiveTab | null {
		const tab = this.find(id);
		if (!tab) {
			return null;
		}
		if (this.active !== id) {
			this.active = id;
			this.layout();
			this.onChange();
		}
		return tab;
	}

	/**
	 * Send one CDP command over the tab's in-process debugger session, attaching on
	 * first use. `attach` throws when a session already exists (e.g. DevTools is
	 * open on those contents), so it is guarded by `isAttached` and its failure is
	 * turned into a legible error rather than an unhandled main-process rejection.
	 */
	private async cdp<T = unknown>(
		tab: LiveTab,
		method: string,
		params?: Record<string, unknown>
	): Promise<T> {
		const dbg = tab.view.webContents.debugger;
		if (!dbg.isAttached()) {
			try {
				dbg.attach(CDP_PROTOCOL_VERSION);
			} catch (e) {
				throw new Error(
					`could not attach the browser debugger: ${e instanceof Error ? e.message : String(e)}`
				);
			}
		}
		return (await dbg.sendCommand(method, params)) as T;
	}

	/** Resolve a snapshot ref to its `backendDOMNodeId`, or fail with a fixable error. */
	private static resolveRef(tab: LiveTab, ref: string): number {
		const backendNodeId = tab.refs.get(ref);
		if (backendNodeId === undefined) {
			throw new RefError(
				tab.refs.size === 0
					? `unknown element ref '${ref}': this tab has no current snapshot (it may have navigated) — call snapshot first`
					: `unknown element ref '${ref}': it is not in this tab's current snapshot — call snapshot again`
			);
		}
		return backendNodeId;
	}

	async snapshot(id: string): Promise<SnapshotResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		await this.cdp(tab, "DOM.enable");
		// "Enables the accessibility domain which causes AXNodeIds to remain
		// consistent between method calls" — we key refs off `backendDOMNodeId`
		// regardless, but the domain must be on for `getFullAXTree`.
		await this.cdp(tab, "Accessibility.enable");
		const { nodes } = await this.cdp<{ nodes: AXNodeLike[] }>(
			tab,
			"Accessibility.getFullAXTree"
		);
		const built = buildSnapshot(nodes ?? []);
		tab.refs = built.refs;
		tab.snapshotId = randomUUID();
		return {
			elements: built.elements,
			snapshot_id: tab.snapshotId,
			tab: this.info(tab),
			truncated: built.truncated,
		};
	}

	async click(id: string, ref: string): Promise<ActionResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const backendNodeId = ElectronTabManager.resolveRef(tab, ref);
		const point = await this.pointFor(tab, backendNodeId, ref);
		// Move first: a page that only reveals its target on hover (menus, custom
		// dropdowns) never sees the press otherwise.
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "none",
			buttons: 0,
			clickCount: 0,
			type: "mouseMoved",
			x: point.x,
			y: point.y,
		});
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "left",
			buttons: 1,
			clickCount: 1,
			type: "mousePressed",
			x: point.x,
			y: point.y,
		});
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "left",
			buttons: 0,
			clickCount: 1,
			type: "mouseReleased",
			x: point.x,
			y: point.y,
		});
		return { ok: true, tab: this.info(tab), x: point.x, y: point.y };
	}

	async type(
		id: string,
		ref: string,
		text: string,
		submit: boolean,
		replace = false
	): Promise<ActionResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const backendNodeId = ElectronTabManager.resolveRef(tab, ref);
		await this.cdp(tab, "DOM.enable");
		await this.scrollIntoView(tab, backendNodeId);
		try {
			await this.cdp(tab, "DOM.focus", { backendNodeId });
		} catch (e) {
			throw new RefError(
				`element '${ref}' cannot take keyboard focus (${e instanceof Error ? e.message : String(e)})`
			);
		}
		// `DOM.focus` only throws for a NON-FOCUSABLE node, which is a much weaker
		// condition than "can accept text": a link, a `tabindex` div, a disabled or
		// read-only input all focus happily and then discard the insertion. Without
		// this check the route returns `{ok: true}` for a write that never landed —
		// a silent no-op the caller cannot distinguish from success.
		await this.assertCanAcceptText(tab, ref);
		if (replace) {
			// `Input.insertText` replaces the current SELECTION, so selecting the
			// field's whole contents first turns append into replace. Done through
			// the editing pipeline (not by assigning `.value`) so React-controlled
			// inputs still observe a real `input` event.
			await this.selectAllInFocused(tab);
			if (text.length === 0) {
				// Nothing to insert, so nothing would replace the selection. Delete it
				// explicitly, otherwise `replace: true, text: ""` — the natural way to
				// ask for "clear this field" — would leave the value untouched.
				await this.cdp(tab, "Input.dispatchKeyEvent", {
					...DELETE_KEY,
					type: "keyDown",
				});
				await this.cdp(tab, "Input.dispatchKeyEvent", {
					...DELETE_KEY,
					type: "keyUp",
				});
			}
		}
		if (text.length > 0) {
			// `Input.insertText` "emulates inserting text that doesn't come from a key
			// press": it goes through the editing pipeline (so React-controlled inputs
			// see a real `input` event) but fires no `keydown`. It inserts at the caret,
			// replacing whatever is selected — which is why `replace` above works by
			// selecting first rather than by clearing separately.
			await this.cdp(tab, "Input.insertText", { text });
		}
		if (submit) {
			// The one keystroke that must be a real key event — forms and
			// search boxes listen for `keydown`, which `insertText` does not produce.
			await this.cdp(tab, "Input.dispatchKeyEvent", {
				...ENTER_KEY,
				text: "\r",
				type: "keyDown",
				unmodifiedText: "\r",
			});
			await this.cdp(tab, "Input.dispatchKeyEvent", {
				...ENTER_KEY,
				type: "keyUp",
			});
		}
		return { ok: true, tab: this.info(tab) };
	}

	async scroll(
		id: string,
		direction: ScrollDirection,
		amount?: number
	): Promise<ActionResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const viewport = await this.viewport(tab);
		const { deltaX, deltaY } = scrollDelta(direction, amount, viewport);
		const x = Math.round(viewport.width / 2);
		const y = Math.round(viewport.height / 2);
		await this.cdp(tab, "Input.dispatchMouseEvent", {
			button: "none",
			buttons: 0,
			deltaX,
			deltaY,
			type: "mouseWheel",
			x,
			y,
		});
		return { ok: true, tab: this.info(tab), x, y };
	}

	/** Viewport size in CSS pixels; the `css*` metrics, since the rest are device px. */
	private async viewport(
		tab: LiveTab
	): Promise<{ height: number; width: number }> {
		try {
			const metrics = await this.cdp<{
				cssLayoutViewport?: { clientHeight?: number; clientWidth?: number };
			}>(tab, "Page.getLayoutMetrics");
			const vp = metrics?.cssLayoutViewport;
			if (
				typeof vp?.clientWidth === "number" &&
				typeof vp.clientHeight === "number" &&
				vp.clientWidth > 0 &&
				vp.clientHeight > 0
			) {
				return { height: vp.clientHeight, width: vp.clientWidth };
			}
		} catch {
			// Fall through to the window-derived fallback below.
		}
		const [width, height] = this.win.getContentSize();
		return width > 0 && height > TAB_STRIP_HEIGHT
			? { height: height - TAB_STRIP_HEIGHT, width }
			: FALLBACK_VIEWPORT;
	}

	/** Best-effort scroll-into-view; a node that refuses still gets a box-model try. */
	/**
	 * Refuse a `type` whose focused element definitively cannot accept text.
	 *
	 * Probes the EFFECTIVE focused element (`document.activeElement`) rather than
	 * the referenced node, because that is exactly where `Input.insertText`
	 * commits — and it is what survives focus delegation (a `<label for>`, a custom
	 * element with `delegatesFocus`), where the referenced node and the node that
	 * actually receives text differ.
	 *
	 * Fails OPEN: anything the probe cannot see through (a closed shadow root, a
	 * cross-origin iframe, an evaluation error) is allowed through. A false
	 * rejection would break working calls, which is worse than the silent no-op
	 * this exists to catch.
	 */
	private async assertCanAcceptText(tab: LiveTab, ref: string): Promise<void> {
		const expression = `(() => {
			let el = document.activeElement;
			// `;
		document.activeElement` reports the shadow HOST, not the focused node
			// inside it, so a web component wrapping an <input> would look like a
			// non-editable custom element. Descend through OPEN roots to the node that
			// actually has focus. A CLOSED root leaves \`shadowRoot === null\`, which the
			// custom-element check below sends to "unknown" (fail open).
			while (el && el.shadowRoot && el.shadowRoot.activeElement) {
				el = el.shadowRoot.activeElement;
			}
			if (!el || el === document.body) return { verdict: "unknown" };
			const tag = el.tagName;
			if (tag === "IFRAME" || tag === "FRAME" || el.shadowRoot === null && tag.includes("-")) {
				return { verdict: "unknown" };
			}
			if (el.isContentEditable) return { verdict: "ok" };
			if (tag === "TEXTAREA" || tag === "INPUT") {
				if (el.disabled) return { verdict: "no", why: "is disabled" };
				if (el.readOnly) return { verdict: "no", why: "is read-only" };
				if (tag === "INPUT") {
					// The input types that hold no caret-editable text. Everything else
					// (text/search/url/email/tel/password/number/date/…) does.
					const opaque = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
					const t = (el.getAttribute("type") || "text").toLowerCase();
					if (opaque.includes(t)) return { verdict: "no", why: "is an <input type=" + t + ">" };
				}
				return { verdict: "ok" };
			}
			return { verdict: "no", why: "is a <" + tag.toLowerCase() + "> that is not editable" };
		})()`;
		let verdict: { verdict?: string; why?: string } | undefined;
		try {
			const res = await this.cdp<{ result?: { value?: unknown } }>(
				tab,
				"Runtime.evaluate",
				{ expression, returnByValue: true }
			);
			verdict = res?.result?.value as { verdict?: string; why?: string };
		} catch {
			return; // fail open — see the doc comment
		}
		if (verdict?.verdict === "no") {
			throw new RefError(
				`element '${ref}' cannot accept text: it ${verdict.why ?? "is not editable"}. ` +
					"Focusing it succeeds but the text would be silently discarded — snapshot again and pick the input itself."
			);
		}
	}

	/**
	 * Select everything in the focused editable so the next `Input.insertText`
	 * overwrites it. Uses the editing pipeline (`selectAll`) rather than assigning
	 * `.value`, so a React-controlled input still sees a real `input` event.
	 */
	private async selectAllInFocused(tab: LiveTab): Promise<void> {
		// `Input.dispatchKeyEvent` with the platform's select-all chord is unreliable
		// across platforms (Cmd vs Ctrl); the editing command is not.
		await this.cdp(tab, "Runtime.evaluate", {
			expression: `(() => {
				// Same shadow-host descent as the editability probe: selecting the
				// HOST's contents would make the following insertText replace the wrong
				// range, which is a silent wrong-write rather than a visible failure.
				let el = document.activeElement;
				while (el && el.shadowRoot && el.shadowRoot.activeElement) {
					el = el.shadowRoot.activeElement;
				}
				if (!el) return false;
				if (typeof el.select === "function") { el.select(); return true; }
				const r = document.createRange();
				r.selectNodeContents(el);
				const s = window.getSelection();
				s.removeAllRanges();
				s.addRange(r);
				return true;
			})()`,
			returnByValue: true,
		});
	}

	private async scrollIntoView(
		tab: LiveTab,
		backendNodeId: number
	): Promise<void> {
		try {
			await this.cdp(tab, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
		} catch {
			// Not fatal on its own — `getBoxModel` below decides whether the element
			// is actually reachable, and its error message is the useful one.
		}
	}

	/** Viewport point to dispatch input at for a referenced element. */
	private async pointFor(
		tab: LiveTab,
		backendNodeId: number,
		ref: string
	): Promise<{ x: number; y: number }> {
		await this.cdp(tab, "DOM.enable");
		await this.scrollIntoView(tab, backendNodeId);
		let model: { content?: unknown } | undefined;
		try {
			const box = await this.cdp<{ model?: { content?: unknown } }>(
				tab,
				"DOM.getBoxModel",
				{ backendNodeId }
			);
			model = box?.model;
		} catch (e) {
			throw new RefError(
				`element '${ref}' has no layout box — it is hidden or gone (${e instanceof Error ? e.message : String(e)}); re-run snapshot`
			);
		}
		const point = quadCenter(model?.content);
		if (!point) {
			throw new RefError(
				`element '${ref}' has an empty layout box (hidden or zero-sized); re-run snapshot`
			);
		}
		return point;
	}

	title(id: string): string | null {
		const tab = this.find(id);
		return tab ? tab.view.webContents.getTitle() : null;
	}
}

function createWindow(): { win: BaseWindow; strip: WebContents } {
	const win = new BaseWindow({ width: 1200, height: 800, show: true });
	const strip = new WebContentsView({
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	win.contentView.addChildView(strip);
	const [width] = win.getContentSize();
	strip.setBounds({ x: 0, y: 0, width, height: TAB_STRIP_HEIGHT });
	win.on("resize", () => {
		const [w] = win.getContentSize();
		strip.setBounds({ x: 0, y: 0, width: w, height: TAB_STRIP_HEIGHT });
	});
	// Renderer served by electron-vite (dev) or the built file (prod).
	if (process.env.ELECTRON_RENDERER_URL) {
		strip.webContents
			.loadURL(process.env.ELECTRON_RENDERER_URL)
			.catch(() => undefined);
	} else {
		strip.webContents
			.loadFile(join(import.meta.dirname, "../renderer/index.html"))
			.catch(() => undefined);
	}
	return { win, strip: strip.webContents };
}

app.whenReady().then(() => {
	const { win, strip } = createWindow();
	const token = resolveControlToken();
	if (!token) {
		// biome-ignore lint/suspicious/noConsole: main-process diagnostic, no renderer.
		console.warn(
			"[ryu-browser] no RYU_EXT_TOKEN/RYU_BROWSER_TOKEN set — control server is FAIL-CLOSED (all protected routes reject). Core injects RYU_EXT_TOKEN when it spawns this sidecar."
		);
	}
	const tabs = new ElectronTabManager(win, () => {
		// Push a lightweight tab snapshot to the strip renderer.
		strip.send("ryu-browser:tabs", tabs.list());
	});
	ipcMain.handle("ryu-browser:list", () => tabs.list());
	startControlServer({ tabs, token }, resolveControlPort());
});

app.on("window-all-closed", () => {
	// Keep running headless: Core manages this sidecar's lifecycle (lazy + idle-stop),
	// so closing the window must not kill the control server on non-macOS either.
	// (No-op; do not app.quit().)
});
