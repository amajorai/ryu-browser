import {
	type BrowserTotpSetupProbe,
	browserCDPAcknowledgementSchema,
	browserCDPCredentialProbeSchema,
	browserCDPDecodedQrSchema,
	browserCDPTotpSetupProbeSchema,
} from "./cdp-records.ts";
import { ElectronTabBase } from "./electron-tab-base.ts";
// Ryu Browser tab manager layer (split from the main process entry; see electron-tab-base.ts).

import { ElectronTabInput } from "./electron-tab-input.ts";
import type { LiveTab } from "./electron-tab-support.ts";
import {
	type ActionResult,
	type BrowserRect,
	RefError,
	type TabManager,
	type TotpSetupSource,
} from "./tab-manager.ts";
import {
	type CredentialField,
	type CredentialTargetProbe,
	performCredentialFill,
} from "./vault-fill.ts";

/** The full tab manager: credential fill and TOTP setup reads on top of input. */
export class ElectronTabManager extends ElectronTabInput implements TabManager {
	/**
	 * Report what holds focus relative to the referenced element. Runs ON the
	 * referenced node (`callFunctionOn`), so `window` is that node's own frame:
	 * a node inside any child frame reports `in_frame` even when it is
	 * same-origin, and a top-level focus that sits on an <iframe> (focus delegated
	 * into a cross-origin frame) reports it too. Unlike `assertCanAcceptText`
	 * this fails CLOSED: anything unexpected becomes a refusal.
	 */
	protected async probeCredentialTarget(
		tab: LiveTab,
		objectId: string
	): Promise<CredentialTargetProbe> {
		const functionDeclaration = `function () {
			const inChildFrame = window !== window.top;
			let el = document.activeElement;
			while (el && el.shadowRoot && el.shadowRoot.activeElement) {
				el = el.shadowRoot.activeElement;
			}
			if (!el || el === document.body) {
				return { in_frame: inChildFrame, focused: false, tag: "", editable: false };
			}
			const target = this;
			const focused = el === target ||
				(typeof target.contains === "function" && target.contains(el)) ||
				(target.shadowRoot ? target.shadowRoot.contains(el) : false) ||
				target.control === el;
			const tag = String(el.tagName || "").toUpperCase();
			return {
				in_frame: inChildFrame || tag === "IFRAME" || tag === "FRAME",
				focused: focused === true,
				tag,
				input_type: tag === "INPUT" ? String(el.type || "text").toLowerCase() : undefined,
				editable: el.isContentEditable === true || tag === "INPUT" || tag === "TEXTAREA",
				disabled: el.disabled === true,
				read_only: el.readOnly === true,
			};
		}`;
		const fallback: CredentialTargetProbe = {
			editable: false,
			focused: false,
			in_frame: true,
			tag: "",
		};
		try {
			const res = await this.cdp(
				tab,
				"Runtime.callFunctionOn",
				browserCDPCredentialProbeSchema,
				{ functionDeclaration, objectId, returnByValue: true }
			);
			return res.result?.value ?? fallback;
		} catch {
			return fallback;
		}
	}

	async fillCredential(
		id: string,
		ref: string,
		field: CredentialField,
		resolveValue: (pageUrl: string) => Promise<string>,
		submit: boolean
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
		const objectId = await this.resolveObject(tab, backendNodeId, ref);
		try {
			await performCredentialFill(
				{
					insert: async (value) => {
						// Replace, never append: a half-typed or browser-autofilled value
						// in front of the secret would make the credential wrong.
						await this.selectAllInFocused(tab);
						await this.cdp(
							tab,
							"Input.insertText",
							browserCDPAcknowledgementSchema,
							{
								text: value,
							}
						);
					},
					pageUrl: () => tab.view.webContents.getURL(),
					probe: () => this.probeCredentialTarget(tab, objectId),
				},
				field,
				resolveValue
			);
		} finally {
			await this.releaseObject(tab, objectId);
		}
		if (submit) {
			await this.pressEnter(tab);
		}
		return { ok: true, tab: this.info(tab) };
	}

	async readTotpSetup(
		id: string,
		ref: string
	): Promise<TotpSetupSource | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const backendNodeId = ElectronTabBase.resolveRef(tab, ref);
		await this.cdp(tab, "DOM.enable", browserCDPAcknowledgementSchema);
		await this.scrollIntoView(tab, backendNodeId);
		const objectId = await this.resolveObject(tab, backendNodeId, ref);
		try {
			const probe = await this.probeTotpSetup(tab, objectId);
			const candidates: string[] = [];
			let qr = probe.qr ?? null;
			if (!qr && probe.detector && probe.media) {
				// The direct decode fails for a cross-origin <img> (a tainted source).
				// The pixels on screen are not tainted, so decode a capture instead.
				qr = await this.decodeQrFromCapture(tab, objectId, probe.media);
			}
			if (qr) {
				candidates.push(qr);
			}
			candidates.push(...(probe.text ?? []));
			return { candidates, in_frame: probe.in_frame, tab: this.info(tab) };
		} finally {
			await this.releaseObject(tab, objectId);
		}
	}

	/**
	 * Read TOTP setup material from (and under) the referenced element: a QR code
	 * decoded with Chromium's `BarcodeDetector` when the element is or contains an
	 * <img>/<canvas>/<svg>/<video>, plus its value/text and any `otpauth:` link.
	 * `BarcodeDetector` is not available on every platform; the text path is the
	 * fallback ("can't scan?" setup keys).
	 */
	protected async probeTotpSetup(
		tab: LiveTab,
		objectId: string
	): Promise<BrowserTotpSetupProbe> {
		const functionDeclaration = `async function () {
			const root = this;
			const out = { in_frame: window !== window.top, qr: null, media: null, detector: typeof BarcodeDetector === "function", text: [] };
			const mediaTags = ["img", "canvas", "svg", "video"];
			const isMedia = (n) => !!n && typeof n.tagName === "string" && mediaTags.includes(n.tagName.toLowerCase());
			const media = isMedia(root) ? root : (typeof root.querySelector === "function" ? root.querySelector("img, canvas, svg, video") : null);
			if (media) {
				const r = media.getBoundingClientRect();
				out.media = { x: r.x, y: r.y, width: r.width, height: r.height };
			}
			if (media && out.detector) {
				try {
					let source = media;
					if (media.tagName.toLowerCase() === "svg") {
						const xml = new XMLSerializer().serializeToString(media);
						const img = new Image();
						img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
						await img.decode();
						source = img;
					}
					const codes = await new BarcodeDetector({ formats: ["qr_code"] }).detect(source);
					if (codes.length > 0) out.qr = String(codes[0].rawValue || "") || null;
				} catch (e) {}
			}
			const push = (v) => {
				if (typeof v === "string" && v.trim() && out.text.length < 16) out.text.push(v.trim().slice(0, 4096));
			};
			push(root.value);
			push(root.innerText);
			push(root.textContent);
			push(root.getAttribute && root.getAttribute("href"));
			if (typeof root.querySelectorAll === "function") {
				for (const a of root.querySelectorAll("a[href^='otpauth:'], input, textarea, code")) {
					push(a.getAttribute("href"));
					push(a.value);
					push(a.textContent);
				}
			}
			return out;
		}`;
		try {
			const res = await this.cdp(
				tab,
				"Runtime.callFunctionOn",
				browserCDPTotpSetupProbeSchema,
				{
					awaitPromise: true,
					functionDeclaration,
					objectId,
					returnByValue: true,
				}
			);
			return res.result?.value ?? { in_frame: false, text: [] };
		} catch {
			return { in_frame: false, text: [] };
		}
	}

	/** Decode a QR code from a capture of the element's on-screen box. */
	protected async decodeQrFromCapture(
		tab: LiveTab,
		objectId: string,
		rect: BrowserRect
	): Promise<string | null> {
		if (rect.width < 1 || rect.height < 1) {
			return null;
		}
		const zoom = tab.view.webContents.getZoomFactor();
		let png: string;
		try {
			const image = await tab.view.webContents.capturePage({
				height: Math.ceil(rect.height * zoom),
				width: Math.ceil(rect.width * zoom),
				x: Math.max(0, Math.floor(rect.x * zoom)),
				y: Math.max(0, Math.floor(rect.y * zoom)),
			});
			png = image.toPNG().toString("base64");
		} catch {
			return null;
		}
		const functionDeclaration = `async function (png) {
			try {
				const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
				const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
				const codes = await new BarcodeDetector({ formats: ["qr_code"] }).detect(bitmap);
				return codes.length > 0 ? String(codes[0].rawValue || "") || null : null;
			} catch (e) {
				return null;
			}
		}`;
		try {
			const res = await this.cdp(
				tab,
				"Runtime.callFunctionOn",
				browserCDPDecodedQrSchema,
				{
					arguments: [{ value: png }],
					awaitPromise: true,
					functionDeclaration,
					objectId,
					returnByValue: true,
				}
			);
			return res.result?.value ?? null;
		} catch {
			return null;
		}
	}
}
