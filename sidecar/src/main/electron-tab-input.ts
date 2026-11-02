import { browserCDPAcknowledgementSchema } from "./cdp-records.ts";
import { ElectronTabBase } from "./electron-tab-base.ts";
import { ElectronTabInspect } from "./electron-tab-inspect.ts";
import { DELETE_KEY, keyDescriptor } from "./electron-tab-support.ts";
import {
	type ActionResult,
	type BrowserCoordinateAction,
	type BrowserMouseButton,
	RefError,
} from "./tab-manager.ts";

/** Pointer and keyboard input: hover, click, drag, keys, and typing. */
export class ElectronTabInput extends ElectronTabInspect {
	async hover(
		id: string,
		ref: string
	): Promise<BrowserCoordinateAction | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const backendNodeId = ElectronTabBase.resolveRef(tab, ref);
		const point = await this.pointFor(tab, backendNodeId, ref);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "none",
				buttons: 0,
				clickCount: 0,
				type: "mouseMoved",
				x: point.x,
				y: point.y,
			}
		);
		return { ok: true, tab: this.info(tab), x: point.x, y: point.y };
	}

	async clickAt(
		id: string,
		x: number,
		y: number,
		button: BrowserMouseButton,
		count: number
	): Promise<BrowserCoordinateAction | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const point = await this.coordinatePoint(tab, x, y);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "none",
				buttons: 0,
				clickCount: 0,
				type: "mouseMoved",
				x: point.x,
				y: point.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button,
				buttons: 1,
				clickCount: count,
				type: "mousePressed",
				x: point.x,
				y: point.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button,
				buttons: 0,
				clickCount: count,
				type: "mouseReleased",
				x: point.x,
				y: point.y,
			}
		);
		return { ok: true, tab: this.info(tab), x: point.x, y: point.y };
	}

	async key(
		id: string,
		keys: string[]
	): Promise<BrowserCoordinateAction | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const descriptors = keys.map(keyDescriptor);
		for (const descriptor of descriptors) {
			await this.cdp(
				tab,
				"Input.dispatchKeyEvent",
				browserCDPAcknowledgementSchema,
				{
					...descriptor,
					type: "keyDown",
				}
			);
		}
		for (const descriptor of [...descriptors].reverse()) {
			await this.cdp(
				tab,
				"Input.dispatchKeyEvent",
				browserCDPAcknowledgementSchema,
				{
					...descriptor,
					type: "keyUp",
				}
			);
		}
		return { ok: true, tab: this.info(tab) };
	}

	async drag(
		id: string,
		from: { x: number; y: number },
		to: { x: number; y: number }
	): Promise<BrowserCoordinateAction | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const start = await this.coordinatePoint(tab, from.x, from.y);
		const end = await this.coordinatePoint(tab, to.x, to.y);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "none",
				buttons: 0,
				clickCount: 0,
				type: "mouseMoved",
				x: start.x,
				y: start.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "left",
				buttons: 1,
				clickCount: 1,
				type: "mousePressed",
				x: start.x,
				y: start.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "left",
				buttons: 1,
				clickCount: 1,
				type: "mouseMoved",
				x: end.x,
				y: end.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "left",
				buttons: 0,
				clickCount: 1,
				type: "mouseReleased",
				x: end.x,
				y: end.y,
			}
		);
		return { ok: true, tab: this.info(tab), x: end.x, y: end.y };
	}

	async click(id: string, ref: string): Promise<ActionResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const backendNodeId = ElectronTabBase.resolveRef(tab, ref);
		const point = await this.pointFor(tab, backendNodeId, ref);
		// Move first: a page that only reveals its target on hover (menus, custom
		// dropdowns) never sees the press otherwise.
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "none",
				buttons: 0,
				clickCount: 0,
				type: "mouseMoved",
				x: point.x,
				y: point.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "left",
				buttons: 1,
				clickCount: 1,
				type: "mousePressed",
				x: point.x,
				y: point.y,
			}
		);
		await this.cdp(
			tab,
			"Input.dispatchMouseEvent",
			browserCDPAcknowledgementSchema,
			{
				button: "left",
				buttons: 0,
				clickCount: 1,
				type: "mouseReleased",
				x: point.x,
				y: point.y,
			}
		);
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
		const backendNodeId = ElectronTabBase.resolveRef(tab, ref);
		await this.cdp(tab, "DOM.enable", browserCDPAcknowledgementSchema);
		await this.scrollIntoView(tab, backendNodeId);
		try {
			await this.cdp(tab, "DOM.focus", browserCDPAcknowledgementSchema, {
				backendNodeId,
			});
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
				await this.cdp(
					tab,
					"Input.dispatchKeyEvent",
					browserCDPAcknowledgementSchema,
					{
						...DELETE_KEY,
						type: "keyDown",
					}
				);
				await this.cdp(
					tab,
					"Input.dispatchKeyEvent",
					browserCDPAcknowledgementSchema,
					{
						...DELETE_KEY,
						type: "keyUp",
					}
				);
			}
		}
		if (text.length > 0) {
			// `Input.insertText` "emulates inserting text that doesn't come from a key
			// press": it goes through the editing pipeline (so React-controlled inputs
			// see a real `input` event) but fires no `keydown`. It inserts at the caret,
			// replacing whatever is selected — which is why `replace` above works by
			// selecting first rather than by clearing separately.
			await this.cdp(tab, "Input.insertText", browserCDPAcknowledgementSchema, {
				text,
			});
		}
		if (submit) {
			await this.pressEnter(tab);
		}
		return { ok: true, tab: this.info(tab) };
	}
}
