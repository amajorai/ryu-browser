import { describe, expect, it } from "bun:test";
import {
	browserCDPAcknowledgementSchema,
	browserCDPAXTreeSchema,
	browserCDPBoxModelSchema,
	browserCDPEditableVerdictSchema,
	browserCDPInspectionSchema,
	browserCDPLayoutMetricsSchema,
	browserCDPParametersSchema,
} from "./cdp-records.ts";

describe("native Chrome DevTools response owners", () => {
	it("accepts native acknowledgements and every emitted input request", () => {
		expect(browserCDPAcknowledgementSchema.parse({})).toEqual({});
		for (const input of [
			{ backendNodeId: 42 },
			{ includeUserAgentShadowDOM: true, x: 10, y: 20 },
			{ expression: "document.activeElement", returnByValue: true },
			{
				type: "mouseWheel",
				x: 42,
				y: 100,
				deltaX: 0,
				deltaY: 640,
				button: "none",
				buttons: 0,
			},
			{
				type: "keyDown",
				code: "Enter",
				key: "Enter",
				nativeVirtualKeyCode: 13,
				windowsVirtualKeyCode: 13,
				text: "\r",
				unmodifiedText: "\r",
			},
			{ text: "Native text" },
		]) {
			expect(browserCDPParametersSchema.safeParse(input).success).toBe(true);
		}
	});
	it("retains actual native AX and inspected-element records", () => {
		const node = {
			nodeId: "node-1",
			backendDOMNodeId: 42,
			role: { type: "role", value: "button" },
			nativeMetadata: { frame: "main" },
		};
		expect(browserCDPAXTreeSchema.parse({ nodes: [node] }).nodes?.[0]).toBe(
			node
		);
		const element = {
			attributes: { id: "submit" },
			computed_styles: { color: "rgb(0, 0, 0)" },
			rect: { x: 42, y: 60, width: 100, height: 30 },
			selector: "#submit",
			tag: "button",
			xpath: "/html/body/button",
			backend_node_id: 42,
			component: undefined,
			text: "Submit",
		};
		expect(
			browserCDPInspectionSchema.parse({ result: { value: element } }).result
				?.value
		).toBe(element);
		expect(
			browserCDPInspectionSchema.parse({ result: { value: null } }).result
				?.value
		).toBeNull();
	});
	it("handles layout fallbacks, native editability and box-model quads", () => {
		const metrics = browserCDPLayoutMetricsSchema.parse({
			cssVisualViewport: {
				clientWidth: 800,
				clientHeight: 600,
				pageX: "bad",
				pageY: 42,
				scale: 1,
				offsetX: 0,
				offsetY: 0,
			},
			cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 },
		});
		expect(metrics.cssVisualViewport?.clientWidth).toBe(800);
		expect(metrics.cssVisualViewport?.pageX).toBeUndefined();
		expect(metrics.cssVisualViewport?.pageY).toBe(42);
		expect(
			browserCDPEditableVerdictSchema.parse({
				result: { value: { verdict: "no", why: "is read-only" } },
			}).result?.value?.verdict
		).toBe("no");
		const quad = [0, 0, 100, 0, 100, 30, 0, 30];
		expect(
			browserCDPBoxModelSchema.parse({
				model: { content: quad, width: 100, height: 30 },
			}).model?.content
		).toEqual(quad);
	});
});
