import type { BrowserAXProtocolValue } from "./ax-records.ts";
import { quadCenter } from "./ax-snapshot.ts";
import { BROWSER_CHROME_HEIGHT } from "./browser-state.ts";
import {
	type BrowserEditableVerdict,
	browserCDPAcknowledgementSchema,
	browserCDPBoxModelSchema,
	browserCDPEditableVerdictSchema,
	browserCDPLayoutMetricsSchema,
	browserCDPResolvedNodeSchema,
} from "./cdp-records.ts";
import {
	type BrowserEvaluationResult,
	browserEvaluationEnvelopeSchema,
} from "./evaluation-records.ts";
import { TabCore } from "./tab-core.ts";
import {
	type BrowserWebMCPExecution,
	type BrowserWebMCPTool,
	RefError,
} from "./tab-manager.ts";
import {
	ENTER_KEY,
	FALLBACK_VIEWPORT,
	type LiveTab,
	type ViewportMetrics,
} from "./tab-support.ts";
import {
	decodeWebMCPResult,
	normalizeWebMCPTools,
	parseWebMCPToolName,
	serializeWebMCPInput,
	WebMCPError,
	webMCPExecutionExpression,
} from "./webmcp.ts";
import type { BrowserWebMCPArguments } from "./webmcp-records.ts";
/** Layer of `ElectronTabManager`; see `electron-tab-manager.ts`. */
export class TabPageOps extends TabCore {
	back(): void {
		this.activeTab()?.view.webContents.goBack();
		this.onChange();
	}

	forward(): void {
		this.activeTab()?.view.webContents.goForward();
		this.onChange();
	}

	reload(): void {
		this.activeTab()?.view.webContents.reload();
		this.onChange();
	}

	findInPage(query: string): void {
		const tab = this.activeTab();
		if (!tab) {
			return;
		}
		if (query.trim() === "") {
			tab.view.webContents.stopFindInPage("clearSelection");
			this.onFindResult({ activeMatchOrdinal: 0, matches: 0 });
			return;
		}
		tab.view.webContents.findInPage(query, { findNext: true });
	}

	stopFindInPage(): void {
		this.activeTab()?.view.webContents.stopFindInPage("clearSelection");
	}

	zoom(action: "in" | "out" | "reset"): void {
		const contents = this.activeTab()?.view.webContents;
		if (!contents) {
			return;
		}
		const factor =
			action === "reset"
				? 1
				: Math.min(
						3,
						Math.max(
							0.5,
							contents.getZoomFactor() + (action === "in" ? 0.1 : -0.1)
						)
					);
		contents.setZoomFactor(Number(factor.toFixed(2)));
		this.onChange();
	}

	toggleDeviceToolbar(): void {
		const contents = this.activeTab()?.view.webContents;
		if (!contents) {
			return;
		}
		this.deviceToolbar = !this.deviceToolbar;
		if (this.deviceToolbar) {
			contents.enableDeviceEmulation({
				deviceScaleFactor: 2,
				scale: 1,
				screenPosition: "mobile",
				screenSize: { height: 812, width: 375 },
				viewPosition: { x: 0, y: 0 },
				viewSize: { height: 812, width: 375 },
			});
		} else {
			contents.disableDeviceEmulation();
		}
		this.onChange();
	}

	activeScreenshot(): Promise<Electron.NativeImage | null> {
		const tab = this.activeTab();
		return tab ? tab.view.webContents.capturePage() : Promise.resolve(null);
	}

	openDevTools(): void {
		this.activeTab()?.view.webContents.openDevTools({ mode: "detach" });
	}

	async screenshot(id: string): Promise<string | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const image = await tab.view.webContents.capturePage();
		return image.toPNG().toString("base64");
	}

	async eval(id: string, expression: string): Promise<BrowserEvaluationResult> {
		const tab = this.find(id);
		if (!tab) {
			return Promise.reject(new Error("no such tab"));
		}
		// PRIVILEGED: Chromium's own JS evaluation in the tab's isolated web contents.
		// Grant-gated (`browser:control`) + bearer-authed + loopback-only upstream.
		const result = await tab.view.webContents.executeJavaScript(
			expression,
			true
		);
		return browserEvaluationEnvelopeSchema.parse({ result }).result;
	}

	protected async inspectWebMCP(tab: LiveTab): Promise<BrowserWebMCPTool[]> {
		const raw = await tab.view.webContents.executeJavaScript(
			"globalThis.__ryuWebMCP?.inspect?.() ?? []",
			true
		);
		return normalizeWebMCPTools(raw);
	}

	async webmcpTools(id: string): Promise<BrowserWebMCPTool[] | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		return this.inspectWebMCP(tab);
	}

	async webmcpExecute(
		id: string,
		name: string,
		input: BrowserWebMCPArguments,
		toolId?: string
	): Promise<BrowserWebMCPExecution | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const toolName = parseWebMCPToolName(name);
		const tools = await this.inspectWebMCP(tab);
		const namedTools = tools.filter((candidate) => candidate.name === toolName);
		const tool = toolId
			? namedTools.find((candidate) => candidate.tool_id === toolId)
			: namedTools.length === 1
				? namedTools[0]
				: null;
		if (!tool) {
			throw new WebMCPError(
				namedTools.length > 1
					? `tool_name '${toolName}' is ambiguous; pass tool_id from the current listing`
					: `no WebMCP tool named '${toolName}'`,
				namedTools.length > 1 ? 400 : 404
			);
		}
		const serializedInput = serializeWebMCPInput(input);
		const rawResult = await tab.view.webContents.executeJavaScript(
			webMCPExecutionExpression(toolName, serializedInput, tool.tool_id),
			true
		);
		return {
			result: decodeWebMCPResult(rawResult),
			tool,
		};
	}

	// ── CDP-backed control (snapshot / click / type / scroll) ────────────────────
	//
	// All four go through `focusForControl`, which makes the target tab the ACTIVE
	// one before any CDP call. That is not cosmetic: an inactive tab's
	// `WebContentsView` is laid out at `{0,0,0,0}`, so `DOM.getBoxModel` returns a
	// degenerate rect and `Input.dispatchMouseEvent` hit-tests against a 0×0 region —
	// input that silently lands nowhere. Focusing first is what makes an explicit
	// `tab_id` behave the same as the active-tab default.

	/**
	 * The one keystroke `submit` needs as a real key event — forms and search
	 * boxes listen for `keydown`, which `insertText` does not produce.
	 */
	protected async pressEnter(tab: LiveTab): Promise<void> {
		await this.cdp(
			tab,
			"Input.dispatchKeyEvent",
			browserCDPAcknowledgementSchema,
			{
				...ENTER_KEY,
				text: "\r",
				type: "keyDown",
				unmodifiedText: "\r",
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchKeyEvent",
			browserCDPAcknowledgementSchema,
			{
				...ENTER_KEY,
				type: "keyUp",
			}
		);
	}

	/** A Runtime remote object for a snapshot ref, for `callFunctionOn`. */
	protected async resolveObject(
		tab: LiveTab,
		backendNodeId: number,
		ref: string
	): Promise<string> {
		let objectId: string | undefined;
		try {
			const resolved = await this.cdp(
				tab,
				"DOM.resolveNode",
				browserCDPResolvedNodeSchema,
				{ backendNodeId }
			);
			objectId = resolved.object?.objectId;
		} catch {
			objectId = undefined;
		}
		if (!objectId) {
			throw new RefError(
				`element '${ref}' is gone from the page; snapshot again`
			);
		}
		return objectId;
	}

	protected async releaseObject(tab: LiveTab, objectId: string): Promise<void> {
		try {
			await this.cdp(
				tab,
				"Runtime.releaseObject",
				browserCDPAcknowledgementSchema,
				{
					objectId,
				}
			);
		} catch {
			// The page may have navigated; its objects are gone with it.
		}
	}

	/** Viewport size in CSS pixels; the `css*` metrics, since the rest are device px. */
	protected async viewportMetrics(tab: LiveTab): Promise<ViewportMetrics> {
		try {
			const metrics = await this.cdp(
				tab,
				"Page.getLayoutMetrics",
				browserCDPLayoutMetricsSchema
			);
			const vp = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
			if (
				vp?.clientWidth !== undefined &&
				vp.clientHeight !== undefined &&
				vp.clientWidth > 0 &&
				vp.clientHeight > 0
			) {
				return {
					height: vp.clientHeight,
					scroll_x: vp.pageX ?? 0,
					scroll_y: vp.pageY ?? 0,
					width: vp.clientWidth,
				};
			}
		} catch {
			// Fall through to the window-derived fallback below.
		}
		const [width, height] = this.win.getContentSize();
		return width > 0 && height > BROWSER_CHROME_HEIGHT
			? {
					height: height - BROWSER_CHROME_HEIGHT,
					scroll_x: 0,
					scroll_y: 0,
					width,
				}
			: { ...FALLBACK_VIEWPORT, scroll_x: 0, scroll_y: 0 };
	}

	protected async viewport(
		tab: LiveTab
	): Promise<{ height: number; width: number }> {
		const metrics = await this.viewportMetrics(tab);
		return { height: metrics.height, width: metrics.width };
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
	protected async assertCanAcceptText(
		tab: LiveTab,
		ref: string
	): Promise<void> {
		const expression = `(() => {
			let el = document.activeElement;
			// document.activeElement reports the shadow HOST, not the focused node
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
		let verdict: BrowserEditableVerdict | undefined;
		try {
			const res = await this.cdp(
				tab,
				"Runtime.evaluate",
				browserCDPEditableVerdictSchema,
				{ expression, returnByValue: true }
			);
			verdict = res?.result?.value;
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
	protected async selectAllInFocused(tab: LiveTab): Promise<void> {
		// `Input.dispatchKeyEvent` with the platform's select-all chord is unreliable
		// across platforms (Cmd vs Ctrl); the editing command is not.
		await this.cdp(tab, "Runtime.evaluate", browserCDPAcknowledgementSchema, {
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

	protected async scrollIntoView(
		tab: LiveTab,
		backendNodeId: number
	): Promise<void> {
		try {
			await this.cdp(
				tab,
				"DOM.scrollIntoViewIfNeeded",
				browserCDPAcknowledgementSchema,
				{ backendNodeId }
			);
		} catch {
			// Not fatal on its own — `getBoxModel` below decides whether the element
			// is actually reachable, and its error message is the useful one.
		}
	}

	/** Viewport point to dispatch input at for a referenced element. */
	protected async pointFor(
		tab: LiveTab,
		backendNodeId: number,
		ref: string
	): Promise<{ x: number; y: number }> {
		await this.cdp(tab, "DOM.enable", browserCDPAcknowledgementSchema);
		await this.scrollIntoView(tab, backendNodeId);
		let model: { content?: BrowserAXProtocolValue } | undefined;
		try {
			const box = await this.cdp(
				tab,
				"DOM.getBoxModel",
				browserCDPBoxModelSchema,
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
}
