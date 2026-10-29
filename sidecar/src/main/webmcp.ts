import { z } from "zod";
import type { BrowserWebMCPTool, WebMCPAnnotations } from "./tab-manager.ts";
import {
	type BrowserWebMCPArguments,
	type BrowserWebMCPJSONValue,
	type BrowserWebMCPRecord,
	type BrowserWebMCPValue,
	browserWebMCPJSONValueSchema,
	browserWebMCPRecordSchema,
	browserWebMCPResultEnvelopeSchema,
} from "./webmcp-records.ts";

/** Keep page-provided tool metadata from consuming an unbounded model context. */
export const MAX_WEBMCP_TOOLS = 64;
export const MAX_WEBMCP_DESCRIPTION_LENGTH = 2000;
export const MAX_WEBMCP_TITLE_LENGTH = 240;
export const MAX_WEBMCP_ORIGIN_LENGTH = 2048;
export const MAX_WEBMCP_SCHEMA_LENGTH = 64_000;
export const MAX_WEBMCP_INPUT_LENGTH = 128_000;
export const MAX_WEBMCP_RESULT_LENGTH = 128_000;
export const MAX_WEBMCP_TOOL_ID_LENGTH = 300;

export const WEBMCP_TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** A caller-fixable WebMCP error with an HTTP status for the sidecar route. */
export class WebMCPError extends Error {
	readonly status: 400 | 404 | 413 | 500;

	constructor(message: string, status: 400 | 404 | 413 | 500 = 500) {
		super(message);
		this.name = "WebMCPError";
		this.status = status;
	}
}

function record(value: BrowserWebMCPValue): BrowserWebMCPRecord | null {
	const parsed = browserWebMCPRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function stringValue(value: BrowserWebMCPValue): string {
	const parsed = z.string().safeParse(value);
	return parsed.success ? parsed.data.trim() : "";
}

function textValue(value: BrowserWebMCPValue, maxLength: number): string {
	return stringValue(value).slice(0, maxLength);
}

function annotations(value: BrowserWebMCPValue): WebMCPAnnotations {
	const candidate = record(value);
	return {
		consequentialHint: candidate?.consequentialHint === true,
		debugging: candidate?.debugging === true,
		readOnlyHint: candidate?.readOnlyHint === true,
		untrustedContentHint: candidate?.untrustedContentHint === true,
	};
}

function schemaString(value: BrowserWebMCPValue): string {
	const stringResult = z.string().safeParse(value);
	const schema = stringResult.success
		? stringResult.data
		: JSON.stringify(value);
	if (
		schema === undefined ||
		schema.length === 0 ||
		schema.length > MAX_WEBMCP_SCHEMA_LENGTH
	) {
		return "";
	}
	try {
		return browserWebMCPRecordSchema.safeParse(JSON.parse(schema)).success
			? schema
			: "";
	} catch {
		return "";
	}
}

/**
 * Validate and bound the safe metadata returned by the page-start bridge.
 * Function-valued callbacks and Window objects never cross this boundary.
 */
export function normalizeWebMCPTools(
	value: BrowserWebMCPValue
): BrowserWebMCPTool[] {
	const parsedTools = z.array(browserWebMCPJSONValueSchema).safeParse(value);
	if (!parsedTools.success) {
		return [];
	}
	const tools: BrowserWebMCPTool[] = [];
	for (const item of parsedTools.data.slice(0, MAX_WEBMCP_TOOLS)) {
		const candidate = record(item);
		if (!candidate) {
			continue;
		}
		const parsedName = z.string().safeParse(candidate.name);
		const name = parsedName.success ? parsedName.data : "";
		const description = textValue(
			candidate.description,
			MAX_WEBMCP_DESCRIPTION_LENGTH
		);
		const inputSchema = schemaString(
			candidate.input_schema ?? candidate.inputSchema
		);
		const origin = textValue(candidate.origin, MAX_WEBMCP_ORIGIN_LENGTH);
		const toolId = textValue(candidate.tool_id, MAX_WEBMCP_TOOL_ID_LENGTH);
		if (
			!(
				name.length <= 128 &&
				WEBMCP_TOOL_NAME_RE.test(name) &&
				description &&
				inputSchema
			)
		) {
			continue;
		}
		tools.push({
			annotations: annotations(candidate.annotations),
			description,
			input_schema: inputSchema,
			name,
			origin,
			tool_id: toolId || `legacy-${tools.length}-${name}`,
			title: textValue(candidate.title, MAX_WEBMCP_TITLE_LENGTH),
		});
	}
	return tools.sort(
		(left, right) =>
			left.name.localeCompare(right.name) ||
			left.tool_id.localeCompare(right.tool_id)
	);
}

export function parseWebMCPToolName(value: BrowserWebMCPValue): string {
	const name = stringValue(value);
	if (!WEBMCP_TOOL_NAME_RE.test(name)) {
		throw new WebMCPError(
			"tool_name must contain 1-128 ASCII letters, numbers, dots, underscores, or hyphens",
			400
		);
	}
	return name;
}

export function parseWebMCPToolId(value: BrowserWebMCPValue): string {
	const toolId = stringValue(value);
	if (!toolId || toolId.length > MAX_WEBMCP_TOOL_ID_LENGTH) {
		throw new WebMCPError(
			"tool_id must be a bounded id returned by the list operation",
			400
		);
	}
	return toolId;
}

export function serializeWebMCPInput(value: BrowserWebMCPArguments): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new WebMCPError("arguments must be JSON-serializable", 400);
	}
	if (serialized.length > MAX_WEBMCP_INPUT_LENGTH) {
		throw new WebMCPError(
			`arguments exceed the ${MAX_WEBMCP_INPUT_LENGTH}-character limit`,
			413
		);
	}
	return serialized;
}

/** Decode the JSON-string result returned by the WebMCP page API. */
export function decodeWebMCPResult(
	value: BrowserWebMCPValue
): BrowserWebMCPJSONValue {
	if (value === undefined) {
		return null;
	}
	const stringResult = z.string().safeParse(value);
	if (!stringResult.success) {
		let serialized: string | undefined;
		try {
			serialized = JSON.stringify(value);
		} catch {
			throw new WebMCPError("tool result must be JSON-serializable", 500);
		}
		if (serialized && serialized.length > MAX_WEBMCP_RESULT_LENGTH) {
			throw new WebMCPError(
				`tool result exceeds the ${MAX_WEBMCP_RESULT_LENGTH}-character limit`,
				413
			);
		}
		return browserWebMCPJSONValueSchema.parse(value);
	}
	const resultText = stringResult.data;
	if (resultText.length > MAX_WEBMCP_RESULT_LENGTH) {
		throw new WebMCPError(
			`tool result exceeds the ${MAX_WEBMCP_RESULT_LENGTH}-character limit`,
			413
		);
	}
	try {
		const parsed = browserWebMCPJSONValueSchema.parse(JSON.parse(resultText));
		const envelopeResult = browserWebMCPResultEnvelopeSchema.safeParse(parsed);
		if (envelopeResult.success) {
			const envelope = envelopeResult.data;
			const envelopeText = z.string().safeParse(envelope.value);
			if (envelope.serializedResult === true && envelopeText.success) {
				try {
					return browserWebMCPJSONValueSchema.parse(
						JSON.parse(envelopeText.data)
					);
				} catch {
					return envelopeText.data;
				}
			}
			return envelope.value;
		}
		return parsed;
	} catch {
		// Native implementations may return a plain string rather than the
		// stringified value required by the current WebMCP examples.
		return resultText;
	}
}

/** Build the only JavaScript expression the main process uses for WebMCP calls. */
export function webMCPExecutionExpression(
	name: string,
	serializedInput: string,
	toolId?: string
): string {
	return `globalThis.__ryuWebMCP.execute(${JSON.stringify(name)}, ${JSON.stringify(serializedInput)}, ${JSON.stringify(toolId)})`;
}

/**
 * A small document-start WebMCP implementation for Electron's older Chromium.
 *
 * It installs the current `document.modelContext` API and the deprecated
 * `navigator.modelContext` alias when the engine does not provide them. The
 * private bridge only returns JSON-safe metadata to the Electron main process;
 * page callbacks remain in the page's own JavaScript realm.
 */
export const WEBMCP_INIT_SCRIPT = String.raw`(() => {
	const BRIDGE_KEY = "__ryuWebMCP";
	const toolWindows = new WeakMap();
	let nextToolWindowId = 0;
	if (globalThis[BRIDGE_KEY]?.version === 1) {
		return;
	}

	const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
	const EXECUTION_TIMEOUT_MS = 30_000;

	function webMCPError(name, message) {
		return new DOMException(message, name);
	}

	function getOrigin() {
		try {
			return typeof location?.origin === "string" ? location.origin : "";
		} catch {
			return "";
		}
	}

	function safeContext() {
		try {
			return document.modelContext || navigator.modelContext || null;
		} catch {
			return null;
		}
	}

	function defineIfMissing(target, key, value) {
		try {
			if (target[key] === undefined) {
				Object.defineProperty(target, key, {
					configurable: true,
					enumerable: true,
					get: () => value,
				});
			}
		} catch {
			// A native implementation may expose a non-configurable alias. Keep it.
		}
	}

	function normalizeAnnotations(value) {
		return {
			consequentialHint: value?.consequentialHint === true,
			debugging: value?.debugging === true,
			readOnlyHint: value?.readOnlyHint === true,
			untrustedContentHint: value?.untrustedContentHint === true,
		};
	}

	function schemaString(value) {
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value)
		) {
			throw webMCPError(
				"TypeError",
				"inputSchema must be a JSON object"
			);
		}
		const serialized = JSON.stringify(value);
		if (typeof serialized !== "string") {
			throw webMCPError("TypeError", "inputSchema must be JSON-serializable");
		}
		return serialized;
	}

	function registeredTool(entry) {
		return {
			annotations: normalizeAnnotations(entry.tool.annotations),
			description: entry.tool.description,
			inputSchema: entry.inputSchema,
			name: entry.tool.name,
			origin: getOrigin(),
			title: typeof entry.tool.title === "string" ? entry.tool.title : "",
			window: globalThis,
		};
	}

	function toolId(tool) {
		const ownerWindow = tool?.window;
		if (
			(typeof ownerWindow !== "object" || ownerWindow === null) &&
			typeof ownerWindow !== "function"
		) {
			return "origin-" + String(tool?.origin || getOrigin()) + "-" + String(tool?.name || "");
		}
		let windowId = toolWindows.get(ownerWindow);
		if (!windowId) {
			windowId = ++nextToolWindowId;
			toolWindows.set(ownerWindow, windowId);
		}
		return "doc-" + windowId + "-" + String(tool?.name || "");
	}

	function normalizeInput(input) {
		const value = typeof input === "string" ? JSON.parse(input) : input;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw webMCPError("DataError", "tool input must be a JSON object");
		}
		return value;
	}

	class RyuModelContext extends EventTarget {
		constructor() {
			super();
			this.tools = new Map();
		}

		registerTool(tool, options = {}) {
			return Promise.resolve().then(() => {
				if (
					!tool ||
					typeof tool !== "object" ||
					typeof tool.name !== "string" ||
					!NAME_RE.test(tool.name) ||
					typeof tool.description !== "string" ||
					tool.description.trim() === "" ||
					typeof tool.execute !== "function"
				) {
					throw webMCPError(
						"InvalidStateError",
						"invalid WebMCP tool definition"
					);
				}
				if (this.tools.has(tool.name)) {
					throw webMCPError(
						"InvalidStateError",
						"a WebMCP tool named " + tool.name + " is already registered"
					);
				}
				const inputSchema = schemaString(tool.inputSchema || {});
				const entry = { inputSchema, tool };
				this.tools.set(tool.name, entry);
				const signal = options?.signal;
				if (signal) {
					if (signal.aborted) {
						this.tools.delete(tool.name);
						throw signal.reason || webMCPError("AbortError", "registration aborted");
					}
					const remove = () => {
						if (this.tools.get(tool.name) === entry) {
							this.tools.delete(tool.name);
							queueMicrotask(() => this.dispatchEvent(new Event("toolchange")));
						}
					};
					signal.addEventListener("abort", remove, { once: true });
				}
				queueMicrotask(() => this.dispatchEvent(new Event("toolchange")));
			});
		}

		getTools() {
			return Promise.resolve(
				[...this.tools.values()]
					.sort((left, right) => left.tool.name.localeCompare(right.tool.name))
					.map(registeredTool)
			);
		}

		executeTool(tool, input = {}, options = {}) {
			return Promise.resolve().then(async () => {
				const name = typeof tool?.name === "string" ? tool.name : "";
				const entry = this.tools.get(name);
				if (!entry) {
					throw webMCPError("NotFoundError", "no WebMCP tool named " + name);
				}
				const inputObject = normalizeInput(input);
				const controller = new AbortController();
				const parentSignal = options?.signal;
				if (parentSignal?.aborted) {
					throw parentSignal.reason || webMCPError("AbortError", "execution aborted");
				}
				let rejectAbort;
				const abortPromise = new Promise((_, reject) => {
					rejectAbort = reject;
				});
				const abort = () => {
					controller.abort(parentSignal?.reason);
					rejectAbort(parentSignal?.reason || webMCPError("AbortError", "execution aborted"));
				};
				parentSignal?.addEventListener("abort", abort, { once: true });
				const timeout = setTimeout(() => {
					controller.abort();
					rejectAbort(webMCPError("TimeoutError", "WebMCP tool execution timed out"));
				}, EXECUTION_TIMEOUT_MS);
				try {
					const execution = Promise.resolve().then(() =>
						entry.tool.execute(inputObject, { signal: controller.signal })
					);
					const result = await Promise.race([execution, abortPromise]);
					const serialized = JSON.stringify(result === undefined ? null : result);
					if (typeof serialized !== "string") {
						throw webMCPError("DataError", "tool result must be JSON-serializable");
					}
					return serialized;
				} finally {
					clearTimeout(timeout);
					parentSignal?.removeEventListener("abort", abort);
				}
			});
		}
	}

	const existing = safeContext();
	const native =
		existing &&
		typeof existing.getTools === "function" &&
		typeof existing.executeTool === "function"
			? existing
			: null;
	const context = native || new RyuModelContext();
	defineIfMissing(document, "modelContext", context);
	defineIfMissing(navigator, "modelContext", context);

	function formControls(form) {
		return Array.from(form.elements || []).filter((control) => {
			const tag = control?.tagName?.toLowerCase();
			const type = (control?.getAttribute?.("type") || "").toLowerCase();
			return (
				(control?.name &&
					(tag === "input" || tag === "select" || tag === "textarea") &&
					type !== "button" &&
					type !== "file" &&
					type !== "hidden" &&
					type !== "image" &&
					type !== "reset" &&
					type !== "submit") ||
				false
			);
		});
	}

	function controlDescription(control) {
		const explicit = control.getAttribute("toolparamdescription");
		if (explicit) {
			return explicit.trim();
		}
		if (control.id) {
			const label = document.querySelector('label[for="' + CSS.escape(control.id) + '"]');
			if (label?.textContent?.trim()) {
				return label.textContent.trim();
			}
		}
		return (control.getAttribute("aria-description") || "").trim();
	}

	function controlSchema(control) {
		const tag = control.tagName.toLowerCase();
		const type = (control.getAttribute("type") || "text").toLowerCase();
		const schema = { type: "string" };
		if (type === "checkbox") {
			schema.type = "boolean";
		} else if (type === "number" || type === "range") {
			schema.type = "number";
		} else if (tag === "select" && control.multiple) {
			schema.type = "array";
			schema.items = { type: "string" };
		}
		const description = controlDescription(control);
		if (description) {
			schema.description = description;
		}
		if (tag === "select" && !control.multiple) {
			const values = Array.from(control.options || [])
				.map((option) => option.value)
				.filter((value, index, values) => value && values.indexOf(value) === index);
			if (values.length > 0) {
				schema.enum = values;
			}
		}
		return schema;
	}

	function formToolDefinition(form) {
		const name = (form.getAttribute("toolname") || "").trim();
		const description = (form.getAttribute("tooldescription") || "").trim();
		if (!(name && description)) {
			return null;
		}
		const controls = formControls(form);
		const properties = {};
		const required = [];
		for (const control of controls) {
			properties[control.name] = controlSchema(control);
			if (control.required) {
				required.push(control.name);
			}
		}
		const inputSchema = { properties, type: "object" };
		if (required.length > 0) {
			inputSchema.required = [...new Set(required)];
		}
		return { controls, description, inputSchema, name };
	}

	function setControlValue(control, value) {
		const type = (control.getAttribute("type") || "").toLowerCase();
		if (type === "checkbox") {
			control.checked = value === true;
		} else if (control.tagName.toLowerCase() === "select" && control.multiple) {
			const values = new Set(Array.isArray(value) ? value.map(String) : []);
			for (const option of Array.from(control.options || [])) {
				option.selected = values.has(option.value);
			}
		} else if (value !== undefined && value !== null) {
			control.value = String(value);
		}
		control.dispatchEvent(new Event("input", { bubbles: true }));
		control.dispatchEvent(new Event("change", { bubbles: true }));
	}

	function namedToolEvent(type, name) {
		const event = new CustomEvent(type);
		try {
			Object.defineProperty(event, "toolName", { value: name });
		} catch {
			// CustomEvent remains useful even if the engine exposes a fixed event shape.
		}
		return event;
	}

	function submitDeclarativeForm(form, name, signal) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (value, error) => {
				if (settled) {
					return;
				}
				settled = true;
				if (signal) {
					signal.removeEventListener("abort", cancel);
				}
				if (error) {
					reject(error);
				} else {
					resolve(value === undefined ? null : value);
				}
			};
			const cancel = () => {
				form.removeAttribute("data-ryu-webmcp-active");
				window.dispatchEvent(namedToolEvent("toolcancel", name));
				finish(null, signal.reason || webMCPError("AbortError", "execution aborted"));
			};
			const onCapture = (event) => {
				try {
					Object.defineProperty(event, "agentInvoked", { value: true });
				} catch {
					// The event still carries the real submit semantics below.
				}
				event.respondWith = (value) => Promise.resolve(value).then(
					(result) => finish(result),
					(error) => finish(null, error)
				);
			};
			const onBubble = () => {
				setTimeout(() => finish(null), 0);
			};
			if (signal) {
				if (signal.aborted) {
					cancel();
					return;
				}
				signal.addEventListener("abort", cancel, { once: true });
			}
			form.addEventListener("submit", onCapture, { capture: true, once: true });
			form.addEventListener("submit", onBubble, { once: true });
			window.dispatchEvent(namedToolEvent("toolactivated", name));
			try {
				form.requestSubmit();
			} catch (error) {
				finish(null, error);
			}
		});
	}

	const declarativeForms = new Map();
	function syncDeclarativeTools() {
		if (native || typeof document.querySelectorAll !== "function") {
			return;
		}
		const current = new Map();
		for (const form of Array.from(document.querySelectorAll("form"))) {
			const definition = formToolDefinition(form);
			if (!definition || !NAME_RE.test(definition.name)) {
				continue;
			}
			const signature = definition.name + "\n" + definition.description + "\n" + JSON.stringify(definition.inputSchema);
			current.set(form, { definition, signature });
		}
		for (const [form, registered] of declarativeForms) {
			const next = current.get(form);
			if (!next || next.signature !== registered.signature) {
				registered.controller.abort();
				declarativeForms.delete(form);
			}
		}
		for (const [form, next] of current) {
			if (declarativeForms.has(form)) {
				continue;
			}
			const controller = new AbortController();
			const registered = { controller, signature: next.signature };
			declarativeForms.set(form, registered);
			context.registerTool(
				{
					description: next.definition.description,
					execute: async (input, options) => {
						form.focus();
						form.setAttribute("data-ryu-webmcp-active", next.definition.name);
						for (const control of next.definition.controls) {
							setControlValue(control, input[control.name]);
						}
						if (!form.hasAttribute("toolautosubmit")) {
							return "Form fields populated; submit the form to complete this action.";
						}
						const result = await submitDeclarativeForm(form, next.definition.name, options?.signal);
						form.removeAttribute("data-ryu-webmcp-active");
						return result;
					},
					inputSchema: next.definition.inputSchema,
					name: next.definition.name,
				},
				{ signal: controller.signal }
			).catch(() => {
				if (declarativeForms.get(form) === registered) {
					declarativeForms.delete(form);
				}
			});
		}
	}
	if (!native) {
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", syncDeclarativeTools, { once: true });
		} else {
			queueMicrotask(syncDeclarativeTools);
		}
		if (typeof MutationObserver === "function") {
			new MutationObserver(syncDeclarativeTools).observe(document, {
				attributeFilter: [
					"aria-description",
					"name",
					"required",
					"toolname",
					"toolparamdescription",
					"tooldescription",
					"toolautosubmit",
					"type",
				],
				attributes: true,
				childList: true,
				subtree: true,
			});
		}
	}

	async function inspect() {
		const tools = await context.getTools();
		return tools
			.map((tool) => {
				let inputSchema = "";
				try {
					inputSchema =
						typeof tool.inputSchema === "string"
							? tool.inputSchema
							: JSON.stringify(tool.inputSchema || {});
				} catch {
					return null;
				}
				return {
					annotations: normalizeAnnotations(tool.annotations),
					description: typeof tool.description === "string" ? tool.description : "",
					input_schema: inputSchema,
					name: typeof tool.name === "string" ? tool.name : "",
					origin: typeof tool.origin === "string" ? tool.origin : getOrigin(),
					tool_id: toolId(tool),
					title: typeof tool.title === "string" ? tool.title : "",
				};
			})
			.filter(Boolean)
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	async function execute(name, serializedInput, requestedToolId) {
		const tools = await context.getTools();
		const matchingTools = tools.filter((candidate) => candidate.name === name);
		const tool = requestedToolId
			? matchingTools.find((candidate) => toolId(candidate) === requestedToolId)
			: matchingTools.length === 1
				? matchingTools[0]
				: null;
		if (!tool) {
			throw webMCPError(
				matchingTools.length > 1 ? "InvalidStateError" : "NotFoundError",
				matchingTools.length > 1
					? "tool_name is ambiguous; pass the tool_id returned by inspect"
					: "no WebMCP tool named " + name
			);
		}
		const inputObject = JSON.parse(serializedInput);
		const result = await context.executeTool(tool, inputObject);
		let value = result;
		if (!native && typeof result === "string") {
			try {
				value = JSON.parse(result);
			} catch {
				// Keep a polyfill result that is already a plain string as-is.
			}
		}
		return JSON.stringify({
			__ryuWebMCPResult: true,
			serializedResult: native !== null,
			value: value === undefined ? null : value,
		});
	}

	const bridge = Object.freeze({ execute, inspect, version: 1 });
	Object.defineProperty(globalThis, BRIDGE_KEY, {
		configurable: false,
		enumerable: false,
		value: bridge,
		writable: false,
	});
})();`;
