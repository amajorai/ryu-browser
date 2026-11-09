import { describe, expect, it } from "bun:test";
import {
	annotationStyle,
	keyDescriptor,
	normalizeRect,
	unionRects,
} from "./tab-support.ts";

describe("tab support helpers", () => {
	it("maps key aliases, letters, and function keys to CDP descriptors", () => {
		expect(keyDescriptor("Ctrl")).toEqual({
			code: "ControlLeft",
			key: "Control",
		});
		expect(keyDescriptor("a")).toEqual({ code: "A", key: "a" });
		expect(keyDescriptor("f5")).toEqual({ code: "F5", key: "F5" });
		expect(keyDescriptor("Insert")).toEqual({ code: "Insert", key: "Insert" });
	});

	it("rejects non-finite or oversized rectangles and unions the rest", () => {
		expect(normalizeRect({ height: 10, width: 10, x: 1, y: 2 })).toEqual({
			height: 10,
			width: 10,
			x: 1,
			y: 2,
		});
		expect(normalizeRect({ height: -1, width: 10, x: 0, y: 0 })).toBeNull();
		expect(normalizeRect({ height: 1, width: 200_000, x: 0, y: 0 })).toBeNull();
		expect(unionRects([])).toBeNull();
		expect(
			unionRects([
				{ height: 10, width: 10, x: 0, y: 0 },
				{ height: 5, width: 5, x: 20, y: 30 },
			])
		).toEqual({ height: 35, width: 25, x: 0, y: 0 });
	});

	it("keeps only safe annotation style values", () => {
		expect(
			annotationStyle({
				color: " red ",
				font_size: "url(https://evil.test)",
				margin: "1px; position: fixed",
			})
		).toEqual({ color: "red" });
		expect(annotationStyle({ padding: "" })).toBeUndefined();
	});
});
