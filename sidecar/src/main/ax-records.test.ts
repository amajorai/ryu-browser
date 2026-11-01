import { describe, expect, it } from "bun:test";
import { browserAXTreeResponseSchema } from "./ax-records.ts";

describe("native accessibility protocol owners", () => {
	it("retains native AX nodes and nested related-node metadata", () => {
		const relatedNodes = [{ backendDOMNodeId: 42, idref: "label" }];
		const node = {
			nodeId: "node-42",
			backendDOMNodeId: 42,
			ignored: false,
			role: { type: "role", value: "button", relatedNodes },
			name: { type: "computedString", value: "Open" },
			properties: [
				{ name: "focused", value: { type: "boolean", value: true } },
			],
			frameId: "main-frame",
			description: { type: "computedString", value: "Native" },
		};
		const parsed = browserAXTreeResponseSchema.parse({ nodes: [node] });
		expect(parsed.nodes[0]).toBe(node);
		expect(parsed.nodes[0]?.role).toBe(node.role);
		expect(node.role.relatedNodes).toBe(relatedNodes);
	});
	it("rejects malformed required identifiers and native property shapes", () => {
		for (const node of [
			{},
			{ nodeId: 42 },
			{ nodeId: "x", childIds: [4] },
			{ nodeId: "x", backendDOMNodeId: "42" },
			{ nodeId: "x", properties: [{ name: "checked", value: false }] },
		]) {
			expect(
				browserAXTreeResponseSchema.safeParse({ nodes: [node] }).success
			).toBe(false);
		}
	});
});
