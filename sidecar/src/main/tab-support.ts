import type { WebContentsView } from "electron";
import { z } from "zod";
import type { BrowserAXProtocolValue } from "./ax-records.ts";
import type { BrowserCaptureProtocolValue } from "./capture-records.ts";
import type { BrowserRawStyleInput } from "./control-records.ts";
import type {
	BrowserAnnotation,
	BrowserElementContext,
	BrowserRect,
	BrowserStyleAdjust,
} from "./tab-manager.ts";

/** CDP version to attach `webContents.debugger` with. */
export const CDP_PROTOCOL_VERSION = "1.3";
/** Fallback viewport when `Page.getLayoutMetrics` reports nothing usable. */
export const FALLBACK_VIEWPORT = { height: 800, width: 1200 };
export const MAX_CONTEXT_SELECTIONS = 8;

export const MAX_ANNOTATION_COMMENT_LENGTH = 4000;

export const INSPECTION_STYLE_PROPERTIES = [
	"background-color",
	"border-radius",
	"color",
	"display",
	"font-family",
	"font-size",
	"font-weight",
	"letter-spacing",
	"line-height",
	"margin",
	"padding",
	"position",
	"text-align",
	"visibility",
	"width",
	"height",
] as const;
/** `Enter`, for `submit: true`. */
export const ENTER_KEY = {
	code: "Enter",
	key: "Enter",
	nativeVirtualKeyCode: 13,
	windowsVirtualKeyCode: 13,
};
/** `Delete`, for `replace: true` with empty text (i.e. "clear this field"). */
export const DELETE_KEY = {
	code: "Delete",
	key: "Delete",
	nativeVirtualKeyCode: 46,
	windowsVirtualKeyCode: 46,
};

export interface LiveTab {
	activityMessageListener?: (
		event: Electron.Event,
		method: string,
		params: BrowserCaptureProtocolValue
	) => void;
	/** Visual notes survive browser-context reads and are cleared on navigation. */
	annotations: BrowserAnnotation[];
	/** Capture observation must be installed before any untrusted navigation. */
	captureReady: Promise<void>;
	id: string;
	loading: boolean;
	/** Element ref (`"@e1"`) → CDP `backendDOMNodeId`, minted by the last snapshot. */
	refs: Map<string, number>;
	/** Id of the last snapshot; cleared refs mean the caller must snapshot again. */
	snapshotId: string | null;
	view: WebContentsView;
}

export interface ViewportMetrics {
	height: number;
	scroll_x: number;
	scroll_y: number;
	width: number;
}

export interface InspectedElement extends BrowserElementContext {
	backend_node_id?: number;
}

export function finiteCoordinate(value: BrowserAXProtocolValue): number | null {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

export function normalizeRect(rect: BrowserRect): BrowserRect | null {
	const x = finiteCoordinate(rect.x);
	const y = finiteCoordinate(rect.y);
	const width = finiteCoordinate(rect.width);
	const height = finiteCoordinate(rect.height);
	if (x === null || y === null || width === null || height === null) {
		return null;
	}
	if (width < 0 || height < 0 || width > 100_000 || height > 100_000) {
		return null;
	}
	return { height, width, x, y };
}

export function unionRects(rects: BrowserRect[]): BrowserRect | null {
	if (rects.length === 0) {
		return null;
	}
	const left = Math.min(...rects.map((rect) => rect.x));
	const top = Math.min(...rects.map((rect) => rect.y));
	const right = Math.max(...rects.map((rect) => rect.x + rect.width));
	const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
	return { height: bottom - top, width: right - left, x: left, y: top };
}

export function annotationStyle(
	style: BrowserStyleAdjust | BrowserRawStyleInput | undefined
): BrowserStyleAdjust | undefined {
	if (!style) {
		return undefined;
	}
	const out: BrowserStyleAdjust = {};
	for (const key of [
		"background_color",
		"color",
		"font_family",
		"font_size",
		"font_weight",
		"letter_spacing",
		"line_height",
		"margin",
		"padding",
	] as const) {
		const parsedValue = z.string().safeParse(style[key]);
		if (!parsedValue.success) {
			continue;
		}
		const trimmed = parsedValue.data.trim();
		if (
			trimmed.length > 0 &&
			trimmed.length <= 160 &&
			!/[;{}]|url\s*\(|expression\s*\(/i.test(trimmed)
		) {
			out[key] = trimmed;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export interface KeyDescriptor {
	code: string;
	key: string;
}

export function keyDescriptor(token: string): KeyDescriptor {
	const normalized = token.trim();
	const lower = normalized.toLowerCase();
	const aliases = new Map<string, KeyDescriptor>(
		Object.entries({
			backspace: { code: "Backspace", key: "Backspace" },
			cmd: { code: "MetaLeft", key: "Meta" },
			command: { code: "MetaLeft", key: "Meta" },
			control: { code: "ControlLeft", key: "Control" },
			ctrl: { code: "ControlLeft", key: "Control" },
			down: { code: "ArrowDown", key: "ArrowDown" },
			end: { code: "End", key: "End" },
			enter: { code: "Enter", key: "Enter" },
			escape: { code: "Escape", key: "Escape" },
			home: { code: "Home", key: "Home" },
			left: { code: "ArrowLeft", key: "ArrowLeft" },
			option: { code: "AltLeft", key: "Alt" },
			page_down: { code: "PageDown", key: "PageDown" },
			page_up: { code: "PageUp", key: "PageUp" },
			return: { code: "Enter", key: "Enter" },
			right: { code: "ArrowRight", key: "ArrowRight" },
			shift: { code: "ShiftLeft", key: "Shift" },
			tab: { code: "Tab", key: "Tab" },
			up: { code: "ArrowUp", key: "ArrowUp" },
		})
	);
	const known = aliases.get(lower);
	if (known) {
		return known;
	}
	if (normalized.length === 1) {
		return { code: normalized.toUpperCase(), key: normalized };
	}
	if (/^f\d{1,2}$/i.test(normalized)) {
		return { code: normalized.toUpperCase(), key: normalized.toUpperCase() };
	}
	return { code: normalized, key: normalized };
}
