import type { BrowserWebMCPTool, WebMCPAnnotations } from "./tab-manager.ts";

/** Keep page-provided tool metadata from consuming an unbounded model context. */
export const MAX_WEBMCP_TOOLS = 64;
export const MAX_WEBMCP_DESCRIPTION_LENGTH = 2000;
export const MAX_WEBMCP_TITLE_LENGTH = 240;
export const MAX_WEBMCP_ORIGIN_LENGTH = 2048;
export const MAX_WEBMCP_SCHEMA_LENGTH = 64_000;
export const MAX_WEBMCP_INPUT_LENGTH = 128_000;
export const MAX_WEBMCP_RESULT_LENGTH = 128_000;

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

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function textValue(value: unknown, maxLength: number): string {
	return stringValue(value).slice(0, maxLength);
}

function annotations(value: unknown): WebMCPAnnotations {
	const candidate = record(value);
	return {
		readOnlyHint: candidate?.readOnlyHint === true,
		untrustedContentHint: candidate?.untrustedContentHint === true,
	};
}

function schemaString(value: unknown): string {
	const schema = typeof value === "string" ? value : JSON.stringify(value);
	if (typeof schema !== "string" || schema.length === 0) {
		return "";
	}
	if (schema.length > MAX_WEBMCP_SCHEMA_LENGTH) {
		return "";
	}
	try {
		const parsed = JSON.parse(schema) as unknown;
		return record(parsed) ? schema : "";
	} catch {
		return "";
	}
}

/**
 * Validate and bound the safe metadata returned by the page-start bridge.
 * Function-valued callbacks and Window objects never cross this boundary.
 */
export function normalizeWebMCPTools(value: unknown): BrowserWebMCPTool[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const tools: BrowserWebMCPTool[] = [];
	for (const item of value.slice(0, MAX_WEBMCP_TOOLS)) {
		const candidate = record(item);
		if (!candidate) {
			continue;
		}
		const name = typeof candidate.name === "string" ? candidate.name : "";
		const description = textValue(
			candidate.description,
			MAX_WEBMCP_DESCRIPTION_LENGTH
		);
		const inputSchema = schemaString(
			candidate.input_schema ?? candidate.inputSchema
		);
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
			origin: textValue(candidate.origin, MAX_WEBMCP_ORIGIN_LENGTH),
			title: textValue(candidate.title, MAX_WEBMCP_TITLE_LENGTH),
		});
	}
	return tools.sort((left, right) => left.name.localeCompare(right.name));
}

export function parseWebMCPToolName(value: unknown): string {
	const name = typeof value === "string" ? value.trim() : "";
	if (!WEBMCP_TOOL_NAME_RE.test(name)) {
		throw new WebMCPError(
			"tool_name must contain 1-128 ASCII letters, numbers, dots, underscores, or hyphens",
			400
		);
	}
	return name;
}

export function serializeWebMCPInput(value: Record<string, unknown>): string {
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
export function decodeWebMCPResult(value: unknown): unknown {
	if (value === undefined) {
		return null;
	}
	if (typeof value !== "string") {
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
		return value;
	}
	if (value.length > MAX_WEBMCP_RESULT_LENGTH) {
		throw new WebMCPError(
			`tool result exceeds the ${MAX_WEBMCP_RESULT_LENGTH}-character limit`,
			413
		);
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		const envelope = record(parsed);
		return envelope?.__ryuWebMCPResult === true && "value" in envelope
			? envelope.value
			: parsed;
	} catch {
		// Native implementations may return a plain string rather than the
		// stringified value required by the current WebMCP examples.
		return value;
	}
}

/** Build the only JavaScript expression the main process uses for WebMCP calls. */
export function webMCPExecutionExpression(
	name: string,
	serializedInput: string
): string {
	return `globalThis.__ryuWebMCP.execute(${JSON.stringify(name)}, ${JSON.stringify(serializedInput)})`;
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
					title: typeof tool.title === "string" ? tool.title : "",
				};
			})
			.filter(Boolean)
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	async function execute(name, serializedInput) {
		const tools = await context.getTools();
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			throw webMCPError("NotFoundError", "no WebMCP tool named " + name);
		}
		const result = await context.executeTool(tool, serializedInput);
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
