import { describe, expect, it } from "bun:test";
import {
	type AXNodeLike,
	buildSnapshot,
	MAX_SNAPSHOT_ELEMENTS,
	MAX_TEXT_LENGTH,
	quadCenter,
	scrollDelta,
} from "./ax-snapshot.ts";

/** Terse AXNode builder in the shape `Accessibility.getFullAXTree` returns. */
function node(
	id: string,
	role: string,
	extra: Partial<AXNodeLike> & { name?: string } = {}
): AXNodeLike {
	const { name, ...rest } = extra;
	return {
		nodeId: id,
		role: { type: "role", value: role },
		...(name === undefined
			? {}
			: { name: { type: "computedString", value: name } }),
		...rest,
	} as AXNodeLike;
}

describe("buildSnapshot", () => {
	it("mints sequential refs bound to backendDOMNodeId, in document order", () => {
		const nodes = [
			node("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2", "3"] }),
			node("2", "link", { backendDOMNodeId: 20, name: "Home", parentId: "1" }),
			node("3", "button", {
				backendDOMNodeId: 30,
				name: "Sign in",
				parentId: "1",
			}),
		];
		const built = buildSnapshot(nodes);
		expect(built.elements.map((e) => e.ref)).toEqual(["@e1", "@e2", "@e3"]);
		expect(built.elements.map((e) => e.name)).toEqual([
			undefined,
			"Home",
			"Sign in",
		]);
		// The ref map is what click/type later resolve — it must carry the DOM
		// backend id, never the AX node id.
		expect(built.refs.get("@e2")).toBe(20);
		expect(built.refs.get("@e3")).toBe(30);
		expect(built.truncated).toBe(false);
	});

	it("drops ignored, structural, and DOM-less nodes but keeps their children", () => {
		const nodes = [
			node("1", "RootWebArea", {
				backendDOMNodeId: 1,
				childIds: ["2", "4", "5"],
			}),
			node("2", "generic", { backendDOMNodeId: 2, childIds: ["3"] }),
			node("3", "button", { backendDOMNodeId: 3, name: "Deep", parentId: "2" }),
			node("4", "link", { backendDOMNodeId: 4, ignored: true, name: "Hidden" }),
			// No backendDOMNodeId: nothing click/type could ever target.
			node("5", "link", { name: "Phantom" }),
		];
		const built = buildSnapshot(nodes);
		expect(built.elements.map((e) => e.name)).toEqual([undefined, "Deep"]);
		// Depth counts EMITTED ancestors: the `generic` wrapper adds no level.
		expect(built.elements[1]?.depth).toBe(1);
	});

	it("drops empty StaticText but keeps text that has content", () => {
		const nodes = [
			node("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2", "3"] }),
			node("2", "StaticText", { backendDOMNodeId: 2, name: "   " }),
			node("3", "StaticText", { backendDOMNodeId: 3, name: "Hello" }),
		];
		expect(buildSnapshot(nodes).elements.map((e) => e.name)).toEqual([
			undefined,
			"Hello",
		]);
	});

	it("keeps whitelisted truthy properties and drops the rest", () => {
		const nodes = [
			node("1", "checkbox", {
				backendDOMNodeId: 1,
				name: "Agree",
				properties: [
					{ name: "checked", value: { type: "tristate", value: true } },
					{ name: "disabled", value: { type: "boolean", value: false } },
					{ name: "level", value: { type: "integer", value: 2 } },
					{ name: "owns", value: { type: "idrefList", value: "x" } },
				],
			}),
		];
		expect(buildSnapshot(nodes).elements[0]?.props).toEqual({
			checked: true,
			level: 2,
		});
	});

	it("truncates long text and caps the element count", () => {
		const long = "x".repeat(MAX_TEXT_LENGTH + 50);
		const many: AXNodeLike[] = [
			node("root", "RootWebArea", {
				backendDOMNodeId: 0,
				childIds: Array.from(
					{ length: MAX_SNAPSHOT_ELEMENTS + 10 },
					(_, i) => `n${i}`
				),
			}),
		];
		for (let i = 0; i < MAX_SNAPSHOT_ELEMENTS + 10; i += 1) {
			many.push(
				node(`n${i}`, "link", {
					backendDOMNodeId: i + 1,
					name: long,
					parentId: "root",
				})
			);
		}
		const built = buildSnapshot(many);
		expect(built.elements).toHaveLength(MAX_SNAPSHOT_ELEMENTS);
		expect(built.truncated).toBe(true);
		expect(built.elements[1]?.name?.length).toBe(MAX_TEXT_LENGTH + 1); // + ellipsis
	});

	it("terminates on a cyclic tree instead of hanging the sidecar", () => {
		const nodes = [
			node("a", "link", {
				backendDOMNodeId: 1,
				childIds: ["b"],
				name: "A",
				parentId: "b",
			}),
			node("b", "link", {
				backendDOMNodeId: 2,
				childIds: ["a"],
				name: "B",
				parentId: "a",
			}),
		];
		const built = buildSnapshot(nodes);
		expect(built.elements).toHaveLength(2);
	});

	it("handles an empty tree", () => {
		const built = buildSnapshot([]);
		expect(built.elements).toEqual([]);
		expect(built.refs.size).toBe(0);
	});
});

describe("quadCenter", () => {
	it("averages a clockwise quad's vertices", () => {
		// CDP quads are [x1,y1, x2,y2, x3,y3, x4,y4], points clock-wise.
		expect(quadCenter([10, 20, 30, 20, 30, 40, 10, 40])).toEqual({
			x: 20,
			y: 30,
		});
	});
	it("rejects degenerate, short, and non-numeric quads", () => {
		// Zero-area = not laid out; clicking its "centre" would hit something else.
		expect(quadCenter([5, 5, 5, 5, 5, 5, 5, 5])).toBeNull();
		expect(quadCenter([0, 0, 10, 0, 10, 0, 0, 0])).toBeNull();
		expect(quadCenter([1, 2, 3, 4])).toBeNull();
		expect(quadCenter(undefined)).toBeNull();
		expect(quadCenter([1, 2, 3, 4, 5, 6, 7, Number.NaN])).toBeNull();
	});
});

describe("scrollDelta", () => {
	const viewport = { height: 800, width: 1000 };

	it("signs the delta per direction (positive deltaY scrolls down)", () => {
		expect(scrollDelta("down", 300, viewport)).toEqual({
			deltaX: 0,
			deltaY: 300,
		});
		expect(scrollDelta("up", 300, viewport)).toEqual({
			deltaX: 0,
			deltaY: -300,
		});
		expect(scrollDelta("right", 300, viewport)).toEqual({
			deltaX: 300,
			deltaY: 0,
		});
		expect(scrollDelta("left", 300, viewport)).toEqual({
			deltaX: -300,
			deltaY: 0,
		});
	});

	it("defaults to a viewport-proportional distance on the scrolled axis", () => {
		expect(scrollDelta("down", undefined, viewport).deltaY).toBe(640);
		expect(scrollDelta("right", undefined, viewport).deltaX).toBe(800);
	});

	it("falls back to the default for a non-positive or non-finite amount", () => {
		expect(scrollDelta("down", 0, viewport).deltaY).toBe(640);
		expect(scrollDelta("down", Number.NaN, viewport).deltaY).toBe(640);
	});

	it("keeps a minimum default on a tiny viewport", () => {
		expect(
			scrollDelta("down", undefined, { height: 10, width: 10 }).deltaY
		).toBe(100);
	});
});
