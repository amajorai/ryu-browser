// Pure shaping helpers for the CDP-backed browser control verbs.
//
// Everything here is deliberately Electron-free and I/O-free: turning a raw
// `Accessibility.getFullAXTree` payload into referenced elements, a box-model quad
// into a click point, and a direction into a wheel delta is where the bugs live, and
// none of it needs a browser to test. `index.ts` owns the CDP calls; this module owns
// what to do with their results.
//
// Protocol shapes are taken from the Chrome DevTools Protocol (tot):
//   Accessibility.getFullAXTree → { nodes: AXNode[] }; AXNode carries
//     { nodeId, ignored, role, name, value, description, properties, parentId,
//       childIds, backendDOMNodeId, frameId }, where role/name/value are AXValue
//     ({ type, value, … }) and properties is AXProperty[] ({ name, value }).
//   DOM.getBoxModel → { model: { content, padding, border, margin, width, height } },
//     each quad "an array of quad vertices, x immediately followed by y for each
//     point, points clock-wise".
//   Page.getLayoutMetrics → { cssLayoutViewport: { clientWidth, clientHeight, … } }
//     ("Metrics relating to the layout viewport in CSS pixels"; the non-`css`
//     variants are documented as deprecated device-pixel values).

import type { ScrollDirection, SnapshotElement } from "./tab-manager.ts";

/** An `AXValue`: `{ type, value }` plus source/related-node detail we ignore. */
export interface AXValueLike {
	type?: string;
	value?: unknown;
}

/** The subset of CDP's `AXNode` this module reads. */
export interface AXNodeLike {
	backendDOMNodeId?: number;
	childIds?: string[];
	ignored?: boolean;
	name?: AXValueLike;
	nodeId: string;
	parentId?: string;
	properties?: { name: string; value: AXValueLike }[];
	role?: AXValueLike;
	value?: AXValueLike;
}

/**
 * Roles carried purely for tree structure. They have no accessible semantics for an
 * agent and, on a real page, outnumber the useful nodes several to one — emitting
 * them would bury the interactive elements the refs exist to address.
 */
const NOISE_ROLES = new Set([
	"generic",
	"GenericContainer",
	"InlineTextBox",
	"LineBreak",
	"none",
	"presentation",
]);

/**
 * Accessibility properties worth surfacing. A whitelist rather than a passthrough:
 * `properties` also carries relation ids and layout noise, and an unbounded map would
 * make the snapshot's size a function of the page's markup rather than its content.
 */
const KEPT_PROPS = new Set([
	"checked",
	"disabled",
	"expanded",
	"focused",
	"invalid",
	"level",
	"multiselectable",
	"pressed",
	"readonly",
	"required",
	"selected",
	"url",
]);

/** Cap on emitted elements. A huge page truncates rather than blowing the response. */
export const MAX_SNAPSHOT_ELEMENTS = 1500;
/** Cap on a single accessible name / value. */
export const MAX_TEXT_LENGTH = 200;

function text(value: AXValueLike | undefined): string | undefined {
	const raw = value?.value;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			return;
		}
		return trimmed.length > MAX_TEXT_LENGTH
			? `${trimmed.slice(0, MAX_TEXT_LENGTH)}…`
			: trimmed;
	}
	if (typeof raw === "number" || typeof raw === "boolean") {
		return String(raw);
	}
	return;
}

function props(
	node: AXNodeLike
): Record<string, boolean | number | string> | undefined {
	const out: Record<string, boolean | number | string> = {};
	for (const entry of node.properties ?? []) {
		if (!KEPT_PROPS.has(entry.name)) {
			continue;
		}
		const raw = entry.value?.value;
		if (typeof raw === "boolean") {
			// `false` is the default for every boolean state here; emitting it doubles
			// the payload to say nothing.
			if (raw) {
				out[entry.name] = true;
			}
			continue;
		}
		if (typeof raw === "number") {
			out[entry.name] = raw;
			continue;
		}
		if (typeof raw === "string" && raw !== "" && raw !== "false") {
			out[entry.name] =
				raw.length > MAX_TEXT_LENGTH
					? `${raw.slice(0, MAX_TEXT_LENGTH)}…`
					: raw;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Whether a node is worth a ref: visible to a11y, has a DOM node, not structural. */
function isInteresting(node: AXNodeLike): boolean {
	if (node.ignored === true) {
		return false;
	}
	if (typeof node.backendDOMNodeId !== "number") {
		// No DOM node ⇒ nothing click/type/scroll could ever target.
		return false;
	}
	const role = text(node.role);
	if (!role || NOISE_ROLES.has(role)) {
		return false;
	}
	// A text node with no text is pure structure.
	return !(role === "StaticText" && !text(node.name));
}

export interface BuiltSnapshot {
	elements: SnapshotElement[];
	/** ref (`"@e1"`) → CDP `backendDOMNodeId`. */
	refs: Map<string, number>;
	truncated: boolean;
}

/**
 * Flatten a full AX tree into referenced elements in document order.
 *
 * Walks `childIds` from the roots rather than trusting the array's order, so `depth`
 * is real nesting. Depth counts EMITTED ancestors only — a chain of four `generic`
 * wrappers must not indent its child four levels for structure the caller never sees.
 * Visited-node tracking makes a malformed (cyclic) tree terminate instead of hanging
 * the sidecar.
 */
export function buildSnapshot(nodes: AXNodeLike[]): BuiltSnapshot {
	const byId = new Map<string, AXNodeLike>();
	for (const node of nodes) {
		byId.set(node.nodeId, node);
	}
	const elements: SnapshotElement[] = [];
	const refs = new Map<string, number>();
	const visited = new Set<string>();
	let truncated = false;
	let seq = 0;

	const walk = (nodeId: string, depth: number): void => {
		if (visited.has(nodeId)) {
			return;
		}
		visited.add(nodeId);
		const node = byId.get(nodeId);
		if (!node) {
			return;
		}
		let childDepth = depth;
		if (isInteresting(node)) {
			if (elements.length >= MAX_SNAPSHOT_ELEMENTS) {
				truncated = true;
				return;
			}
			seq += 1;
			const ref = `@e${seq}`;
			// `isInteresting` already established this is a number.
			refs.set(ref, node.backendDOMNodeId as number);
			const element: SnapshotElement = {
				depth,
				ref,
				role: text(node.role) ?? "unknown",
			};
			const name = text(node.name);
			if (name !== undefined) {
				element.name = name;
			}
			const value = text(node.value);
			if (value !== undefined) {
				element.value = value;
			}
			const extra = props(node);
			if (extra !== undefined) {
				element.props = extra;
			}
			elements.push(element);
			childDepth = depth + 1;
		}
		for (const childId of node.childIds ?? []) {
			walk(childId, childDepth);
		}
	};

	// Roots: anything whose parent is not part of this payload. Covers both the
	// documented root and any orphaned subtree the page produced.
	for (const node of nodes) {
		if (node.parentId === undefined || !byId.has(node.parentId)) {
			walk(node.nodeId, 0);
		}
	}
	// Defensive: a payload whose every node claims an in-payload parent (a cycle)
	// would emit nothing above, so sweep anything still unvisited.
	for (const node of nodes) {
		walk(node.nodeId, 0);
	}
	return { elements, refs, truncated };
}

/**
 * Centre of a CDP box-model quad, in viewport CSS pixels. Returns null for a missing
 * or degenerate quad — a zero-area box means the element is not laid out, and
 * clicking its "centre" would dispatch input at a point that hits something else.
 */
export function quadCenter(quad: unknown): { x: number; y: number } | null {
	if (!Array.isArray(quad) || quad.length < 8) {
		return null;
	}
	const nums = quad.slice(0, 8).map(Number);
	if (nums.some((n) => !Number.isFinite(n))) {
		return null;
	}
	const xs = [nums[0], nums[2], nums[4], nums[6]];
	const ys = [nums[1], nums[3], nums[5], nums[7]];
	const width = Math.max(...xs) - Math.min(...xs);
	const height = Math.max(...ys) - Math.min(...ys);
	if (width <= 0 || height <= 0) {
		return null;
	}
	return {
		x: Math.round(xs.reduce((a, b) => a + b, 0) / 4),
		y: Math.round(ys.reduce((a, b) => a + b, 0) / 4),
	};
}

/** Fraction of the viewport a default (amount-less) scroll travels. */
const DEFAULT_SCROLL_FRACTION = 0.8;
const MIN_DEFAULT_SCROLL = 100;

/**
 * Wheel deltas for a direction. CDP's `Input.dispatchMouseEvent` mouseWheel takes
 * `deltaX`/`deltaY` in CSS pixels with the same sign convention as a DOM wheel event:
 * POSITIVE `deltaY` scrolls the content DOWN.
 */
export function scrollDelta(
	direction: ScrollDirection,
	amount: number | undefined,
	viewport: { height: number; width: number }
): { deltaX: number; deltaY: number } {
	const vertical = direction === "up" || direction === "down";
	const span = vertical ? viewport.height : viewport.width;
	const fallback = Math.max(
		MIN_DEFAULT_SCROLL,
		Math.round(span * DEFAULT_SCROLL_FRACTION)
	);
	const distance =
		typeof amount === "number" && Number.isFinite(amount) && amount > 0
			? Math.round(amount)
			: fallback;
	switch (direction) {
		case "down":
			return { deltaX: 0, deltaY: distance };
		case "up":
			return { deltaX: 0, deltaY: -distance };
		case "right":
			return { deltaX: distance, deltaY: 0 };
		default:
			return { deltaX: -distance, deltaY: 0 };
	}
}
