import { describe, expect, it } from "bun:test";
import { Script } from "node:vm";
import { z } from "zod";
import type { browserWebMCPToolSchema } from "./control-replies.ts";
import {
	decodeWebMCPResult,
	normalizeWebMCPTools,
	parseWebMCPToolId,
	parseWebMCPToolName,
	serializeWebMCPInput,
	WEBMCP_INIT_SCRIPT,
} from "./webmcp.ts";
import type {
	BrowserWebMCPArguments,
	BrowserWebMCPJSONValue,
	BrowserWebMCPRecord,
} from "./webmcp-records.ts";

interface FixtureTool {
	description?: string;
	inputSchema?: BrowserWebMCPJSONValue;
	name: string;
	origin?: string;
	window?: object;
}
interface FixtureWindowTool extends FixtureTool {
	window: object;
}
interface FixtureNativeContext {
	executeTool(
		tool: FixtureWindowTool,
		input: BrowserWebMCPArguments
	): Promise<string>;
	getTools(): Promise<FixtureTool[]>;
}
interface FixtureAddTool {
	description: string;
	execute(input: { text: string }): Promise<{ added: string }>;
	inputSchema: BrowserWebMCPRecord;
	name: string;
}
const fixtureModelContextMethodsSchema = z.object({
	getTools: z.custom<() => Promise<{ name: string; inputSchema: string }[]>>(
		(value) => z.function().safeParse(value).success
	),
	registerTool: z.custom<
		(tool: FixtureAddTool, options?: { signal?: AbortSignal }) => Promise<void>
	>((value) => z.function().safeParse(value).success),
	executeTool: z.custom<
		(tool: FixtureTool, input: BrowserWebMCPArguments) => Promise<string>
	>((value) => z.function().safeParse(value).success),
});
const fixtureModelContextSchema = z.custom<
	z.output<typeof fixtureModelContextMethodsSchema>
>((value) => fixtureModelContextMethodsSchema.safeParse(value).success);
const fixtureBridgeMethodsSchema = z.object({
	execute: z.custom<
		(name: string, input: string, toolId?: string) => Promise<string>
	>((value) => z.function().safeParse(value).success),
	inspect: z.custom<() => Promise<z.output<typeof browserWebMCPToolSchema>[]>>(
		(value) => z.function().safeParse(value).success
	),
});
const fixtureBridgeSchema = z.custom<
	z.output<typeof fixtureBridgeMethodsSchema>
>((value) => fixtureBridgeMethodsSchema.safeParse(value).success);
interface FakeDocument {
	modelContext?:
		| FixtureNativeContext
		| z.output<typeof fixtureModelContextSchema>;
}
interface FakePage {
	__ryuWebMCP?: z.output<typeof fixtureBridgeSchema>;
	AbortController: typeof AbortController;
	Array: typeof Array;
	clearTimeout: typeof clearTimeout;
	DOMException: typeof DOMException;
	document: FakeDocument;
	Event: typeof Event;
	EventTarget: typeof EventTarget;
	JSON: typeof JSON;
	location: { origin: string };
	Map: typeof Map;
	navigator: { modelContext?: FakeDocument["modelContext"] };
	Object: typeof Object;
	Promise: typeof Promise;
	queueMicrotask: typeof queueMicrotask;
	setTimeout: typeof setTimeout;
	top?: FakePage;
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
				annotations: {
					consequentialHint: true,
					debugging: true,
					readOnlyHint: true,
				},
				description: " Read data ",
				input_schema: '{"type":"object"}',
				name: "z-tool",
				origin: "https://example.test",
				tool_id: "doc-1-z-tool",
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
			consequentialHint: true,
			debugging: true,
			readOnlyHint: true,
			untrustedContentHint: false,
		});
		expect(tools[1]?.tool_id).toBe("doc-1-z-tool");
	});

	it("validates the name and bounds JSON input", () => {
		expect(parseWebMCPToolName("orders.lookup")).toBe("orders.lookup");
		expect(() => parseWebMCPToolName("bad name")).toThrow();
		expect(parseWebMCPToolId("doc-2-orders.lookup")).toBe(
			"doc-2-orders.lookup"
		);
		expect(() => parseWebMCPToolId("x".repeat(301))).toThrow();
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
		const context = fixtureModelContextSchema.parse(page.document.modelContext);
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
			JSON.parse(await context.executeTool(tools[0], { text: "hello" }))
		).toEqual({
			added: "hello",
		});

		const bridge = fixtureBridgeSchema.parse(page.__ryuWebMCP);
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

	it("passes an object to the current native executeTool signature", async () => {
		const inputs: BrowserWebMCPArguments[] = [];
		const nativeContext = {
			executeTool: async (
				_tool: FixtureWindowTool,
				input: BrowserWebMCPArguments
			) => {
				inputs.push(input);
				return JSON.stringify("page result");
			},
			getTools: async () => [
				{
					description: "Read a page.",
					inputSchema: { type: "object" },
					name: "read_page",
					origin: "https://example.test",
					window: {},
				},
			],
		};
		const page = createPage();
		page.document.modelContext = nativeContext;
		new Script(WEBMCP_INIT_SCRIPT).runInNewContext(page);
		const bridge = fixtureBridgeSchema.parse(page.__ryuWebMCP);

		expect(
			decodeWebMCPResult(await bridge.execute("read_page", '{"path":"/"}'))
		).toBe("page result");
		expect(inputs).toEqual([{ path: "/" }]);
	});

	it("disambiguates same-name tools from separate document contexts", async () => {
		const firstWindow = {};
		const secondWindow = {};
		const executions: {
			tool: FixtureWindowTool;
			input: BrowserWebMCPArguments;
		}[] = [];
		const nativeContext = {
			executeTool: async (
				tool: FixtureWindowTool,
				input: BrowserWebMCPArguments
			) => {
				executions.push({ tool, input });
				return JSON.stringify(
					tool.window === secondWindow ? "second" : "first"
				);
			},
			getTools: async () => [
				{
					description: "Read a page in the first frame.",
					inputSchema: { type: "object" },
					name: "read_page",
					origin: "https://example.test",
					window: firstWindow,
				},
				{
					description: "Read a page in the second frame.",
					inputSchema: { type: "object" },
					name: "read_page",
					origin: "https://example.test",
					window: secondWindow,
				},
			],
		};
		const page = createPage();
		page.document.modelContext = nativeContext;
		new Script(WEBMCP_INIT_SCRIPT).runInNewContext(page);
		const bridge = fixtureBridgeSchema.parse(page.__ryuWebMCP);
		const tools = await bridge.inspect();

		expect(tools).toHaveLength(2);
		expect(tools[0]?.tool_id).not.toBe(tools[1]?.tool_id);
		await expect(bridge.execute("read_page", "{}")).rejects.toThrow(
			"ambiguous"
		);
		expect(
			decodeWebMCPResult(
				await bridge.execute("read_page", "{}", tools[1]?.tool_id)
			)
		).toBe("second");
		expect(executions).toHaveLength(1);
	});
});
