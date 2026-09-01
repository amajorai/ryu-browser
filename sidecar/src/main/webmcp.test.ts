import { describe, expect, it } from "bun:test";
import { Script } from "node:vm";
import {
	decodeWebMCPResult,
	normalizeWebMCPTools,
	parseWebMCPToolName,
	serializeWebMCPInput,
	WEBMCP_INIT_SCRIPT,
} from "./webmcp.ts";

interface FakeDocument {
	modelContext?: unknown;
}

interface FakePage extends Record<string, unknown> {
	document: FakeDocument;
	location: { origin: string };
	navigator: Record<string, unknown>;
}

function createPage(): FakePage {
	const page: FakePage = {
		AbortController,
		Array,
		clearTimeout,
		DOMException,
		document: {},
		Event,
		EventTarget,
		JSON,
		location: { origin: "https://example.test" },
		Map,
		navigator: {},
		Object,
		Promise,
		queueMicrotask,
		setTimeout,
	};
	page.top = page;
	return page;
}

describe("WebMCP metadata helpers", () => {
	it("keeps safe, valid metadata and sorts tools by name", () => {
		const tools = normalizeWebMCPTools([
			{
				annotations: { readOnlyHint: true },
				description: " Read data ",
				input_schema: '{"type":"object"}',
				name: "z-tool",
				origin: "https://example.test",
			},
			{
				description: "not valid",
				input_schema: "[]",
				name: "bad name",
			},
			{
				description: "too long",
				input_schema: '{"type":"object"}',
				name: "a".repeat(129),
			},
			{
				description: "Write data",
				inputSchema: { type: "object", required: ["id"] },
				name: "a.tool",
			},
		]);

		expect(tools.map((tool) => tool.name)).toEqual(["a.tool", "z-tool"]);
		expect(tools[0]?.input_schema).toBe('{"type":"object","required":["id"]}');
		expect(tools[1]?.annotations).toEqual({
			readOnlyHint: true,
			untrustedContentHint: false,
		});
	});

	it("validates the name and bounds JSON input", () => {
		expect(parseWebMCPToolName("orders.lookup")).toBe("orders.lookup");
		expect(() => parseWebMCPToolName("bad name")).toThrow();
		expect(() =>
			serializeWebMCPInput({ value: "x".repeat(128_001) })
		).toThrow();
	});

	it("decodes JSON-string results and leaves native plain strings intact", () => {
		expect(decodeWebMCPResult('{"ok":true}')).toEqual({ ok: true });
		expect(
			decodeWebMCPResult('{"__ryuWebMCPResult":true,"value":"{\\"ok\\":true}"}')
		).toBe('{"ok":true}');
		expect(decodeWebMCPResult("Done")).toBe("Done");
		expect(decodeWebMCPResult(undefined)).toBeNull();
	});
});

describe("document-start WebMCP bridge", () => {
	it("registers, discovers, executes, and unregisters a page tool", async () => {
		const page = createPage();
		new Script(WEBMCP_INIT_SCRIPT).runInNewContext(page);
		const context = page.document.modelContext as {
			getTools: () => Promise<Array<{ name: string; inputSchema: string }>>;
			registerTool: (
				tool: Record<string, unknown>,
				options?: unknown
			) => Promise<void>;
			executeTool: (tool: unknown, input: string) => Promise<string>;
		};
		const controller = new AbortController();
		await context.registerTool(
			{
				description: "Add an item",
				execute: async (input: { text: string }) => ({ added: input.text }),
				inputSchema: {
					properties: { text: { type: "string" } },
					type: "object",
				},
				name: "add_item",
			},
			{ signal: controller.signal }
		);

		const tools = await context.getTools();
		expect(tools).toHaveLength(1);
		expect(tools[0]?.inputSchema).toBe(
			'{"properties":{"text":{"type":"string"}},"type":"object"}'
		);
		expect(
			JSON.parse(await context.executeTool(tools[0], '{"text":"hello"}'))
		).toEqual({
			added: "hello",
		});

		const bridge = page.__ryuWebMCP as {
			execute: (name: string, input: string) => Promise<string>;
			inspect: () => Promise<Array<{ name: string; origin: string }>>;
		};
		expect(await bridge.inspect()).toEqual([
			expect.objectContaining({
				name: "add_item",
				origin: "https://example.test",
			}),
		]);
		expect(
			decodeWebMCPResult(await bridge.execute("add_item", '{"text":"bridge"}'))
		).toEqual({ added: "bridge" });

		controller.abort();
		expect(await context.getTools()).toEqual([]);
	});

	it("keeps a native model context and adds the compatibility alias", () => {
		const page = createPage();
		const nativeContext = {
			executeTool: async () => "ok",
			getTools: async () => [],
		};
		page.document.modelContext = nativeContext;
		new Script(WEBMCP_INIT_SCRIPT).runInNewContext(page);
		expect(page.document.modelContext).toBe(nativeContext);
		expect(page.navigator.modelContext).toBe(nativeContext);
	});
});
