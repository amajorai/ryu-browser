import { runCaptureTotp, runFillCredential } from "./control-credentials.ts";
import {
	badRequest,
	type ControlResponse,
	type CredentialContext,
	MAX_SCROLL_AMOUNT,
	noSuchTab,
	notFound,
	parseRect,
	parseSelections,
	parseStyle,
} from "./control-parsing.ts";
import {
	type BrowserControlBody,
	type BrowserControlValue,
	browserControlAnnotationKindSchema,
	browserControlBodySchema,
	browserControlKeysSchema,
	browserControlMouseButtonSchema,
	browserControlScrollDirectionSchema,
	browserControlString,
} from "./control-records.ts";
import {
	type BrowserAnnotationInput,
	type BrowserContextRequest,
	RefError,
	type TabManager,
} from "./tab-manager.ts";
import { VaultFillError } from "./vault-fill.ts";
import {
	parseWebMCPToolId,
	parseWebMCPToolName,
	serializeWebMCPInput,
	WebMCPError,
} from "./webmcp.ts";
import { browserWebMCPArgumentsSchema } from "./webmcp-records.ts";

export async function runClick(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const ref = (browserControlString(parsed.ref) ?? "").trim();
	if (ref === "") {
		return badRequest("missing ref");
	}
	const result = await tabs.click(tabId, ref);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

export async function runType(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const ref = (browserControlString(parsed.ref) ?? "").trim();
	if (ref === "") {
		return badRequest("missing ref");
	}
	const text = browserControlString(parsed.text);
	if (text === undefined) {
		return badRequest("missing text");
	}
	const result = await tabs.type(
		tabId,
		ref,
		text,
		parsed.submit === true,
		parsed.replace === true
	);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

export async function runScroll(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const direction = browserControlScrollDirectionSchema.safeParse(
		parsed.direction
	);
	if (!direction.success) {
		return badRequest("direction must be one of up, down, left, right");
	}
	let amount: number | undefined;
	if (parsed.amount !== undefined && parsed.amount !== null) {
		const raw = Number(parsed.amount);
		if (!Number.isFinite(raw) || raw <= 0) {
			return badRequest("amount must be a positive number of pixels");
		}
		// The canonical `browser.scroll.amount` is an unbounded integer, so an
		// enormous value is a LEGAL request the schema promised. Clamping to what a
		// wheel event can usefully travel keeps that promise; refusing it would make
		// the sidecar narrower than the verb it serves.
		amount = Math.min(raw, MAX_SCROLL_AMOUNT);
	}
	const result = await tabs.scroll(tabId, direction.data, amount);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

export async function runContext(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const selections = parseSelections(parsed.selections);
	if (!selections) {
		return badRequest("selections must be an array of valid rectangles");
	}
	const result = await tabs.context(tabId, {
		include_screenshot: parsed.include_screenshot !== false,
		selections,
	} satisfies BrowserContextRequest);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

export async function runWebMCPExecute(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	let name: string;
	try {
		name = parseWebMCPToolName(parsed.tool_name);
	} catch (error) {
		return {
			status: error instanceof WebMCPError ? error.status : 400,
			json: {
				error: error instanceof Error ? error.message : "invalid tool_name",
				ok: false,
			},
		};
	}
	let toolId: string | undefined;
	if (parsed.tool_id !== undefined) {
		try {
			toolId = parseWebMCPToolId(parsed.tool_id);
		} catch (error) {
			return {
				status: error instanceof WebMCPError ? error.status : 400,
				json: {
					error: error instanceof Error ? error.message : "invalid tool_id",
					ok: false,
				},
			};
		}
	}
	const parsedInput = browserWebMCPArgumentsSchema.safeParse(
		parsed.arguments === undefined ? {} : parsed.arguments
	);
	const input = parsedInput.success ? parsedInput.data : null;
	if (!input) {
		return badRequest("arguments must be a JSON object");
	}
	try {
		serializeWebMCPInput(input);
	} catch (error) {
		return {
			status: error instanceof WebMCPError ? error.status : 400,
			json: {
				error: error instanceof Error ? error.message : "invalid arguments",
				ok: false,
			},
		};
	}
	try {
		const execution = await tabs.webmcpExecute(tabId, name, input, toolId);
		if (!execution) {
			return noSuchTab(true);
		}
		return {
			status: 200,
			json: {
				origin: execution.tool.origin,
				result: execution.result,
				tool_name: execution.tool.name,
				tool_id: execution.tool.tool_id,
				consequential_hint: execution.tool.annotations.consequentialHint,
				debugging_hint: execution.tool.annotations.debugging,
				untrusted_content: true,
				untrusted_content_hint:
					execution.tool.annotations.untrustedContentHint === true,
			},
		};
	} catch (error) {
		return {
			status: error instanceof WebMCPError ? error.status : 500,
			json: {
				error:
					error instanceof Error ? error.message : "WebMCP execution failed",
				ok: false,
			},
		};
	}
}

export async function runAnnotation(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const kind = browserControlAnnotationKindSchema.safeParse(parsed.kind);
	if (!kind.success) {
		return badRequest("kind must be area, element, or elements");
	}
	const comment = (browserControlString(parsed.comment) ?? "").trim();
	if (!comment) {
		return badRequest("missing comment");
	}
	const rect = parseRect(parsed.rect);
	if (!rect) {
		return badRequest("rect must contain finite x, y, width, and height");
	}
	const selections = parseSelections(parsed.selections);
	if (selections === null) {
		return badRequest("selections must be an array of valid rectangles");
	}
	const result = await tabs.annotate(tabId, {
		comment,
		kind: kind.data,
		rect,
		selections: selections.length > 0 ? selections : [rect],
		style: parseStyle(parsed.style),
	} satisfies BrowserAnnotationInput);
	return result === null ? noSuchTab(true) : { status: 201, json: result };
}

export async function runHover(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const ref = (browserControlString(parsed.ref) ?? "").trim();
	if (!ref) {
		return badRequest("missing ref");
	}
	const result = await tabs.hover(tabId, ref);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

export function parsePoint(
	value: BrowserControlValue
): { x: number; y: number } | null {
	const parsed = browserControlBodySchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const point = parsed.data;
	const x = Number(point.x);
	const y = Number(point.y);
	return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export async function runClickAt(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const x = Number(parsed.x);
	const y = Number(parsed.y);
	const button = browserControlMouseButtonSchema.safeParse(
		parsed.button === undefined ? "left" : parsed.button
	);
	const count = parsed.count === undefined ? 1 : Number(parsed.count);
	if (
		!(
			Number.isFinite(x) &&
			Number.isFinite(y) &&
			button.success &&
			Number.isInteger(count)
		) ||
		count < 1 ||
		count > 3
	) {
		return badRequest("x/y, button, or count is invalid");
	}
	const result = await tabs.clickAt(tabId, x, y, button.data, count);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

export async function runKey(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const keys = browserControlKeysSchema.safeParse(parsed.keys);
	if (!keys.success) {
		return badRequest("keys must be a non-empty array of key names");
	}
	const result = await tabs.key(tabId, keys.data);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

export async function runDrag(
	tabs: TabManager,
	tabId: string,
	parsed: BrowserControlBody
): Promise<ControlResponse> {
	const from = parsePoint(parsed.from);
	const to = parsePoint(parsed.to);
	if (!(from && to)) {
		return badRequest("from and to must contain finite x and y coordinates");
	}
	const result = await tabs.drag(tabId, from, to);
	return result === null ? noSuchTab(true) : { status: 200, json: result };
}

/**
 * The three synthetic-input routes (`/click`, `/type`, `/scroll`).
 *
 * They are FLAT rather than `/tabs/:id/…` on purpose: the canonical verbs
 * (`browser.click` / `browser.type` / `browser.scroll`) make `tab_id` OPTIONAL —
 * "omit for the active tab" — and a declarative http tool interpolates a path
 * parameter unconditionally, so a `/tabs/{id}/click` route would hard-fail the whole
 * call the moment a model exercised that documented option. Carrying the tab in the
 * body lets the omission mean what the schema says it means. `snapshot` keeps the
 * path shape because ITS canonical `tab_id` is required.
 *
 * `/fill-credential` and `/capture-totp` (agent accounts, `vault-fill.ts`) ride
 * the same flat shape. They take the calling agent from Core's stamped lane
 * header, never from the request, and never echo a secret.
 */
export async function handleControlAction(
	method: string,
	path: string,
	parsed: BrowserControlBody,
	tabs: TabManager,
	credential: CredentialContext = { agentId: undefined, vault: null }
): Promise<ControlResponse> {
	if (method !== "POST") {
		return notFound();
	}
	const raw = browserControlString(parsed.tab_id);
	const explicit = raw !== undefined && raw.trim() !== "";
	const tabId = explicit ? raw.trim() : tabs.activeId();
	if (tabId === null || !tabs.list().some((t) => t.id === tabId)) {
		return noSuchTab(explicit);
	}
	try {
		if (path === "/click") {
			return await runClick(tabs, tabId, parsed);
		}
		if (path === "/type") {
			return await runType(tabs, tabId, parsed);
		}
		if (path === "/scroll") {
			return await runScroll(tabs, tabId, parsed);
		}
		if (path === "/hover") {
			return await runHover(tabs, tabId, parsed);
		}
		if (path === "/click-at") {
			return await runClickAt(tabs, tabId, parsed);
		}
		if (path === "/key") {
			return await runKey(tabs, tabId, parsed);
		}
		if (path === "/fill-credential") {
			return await runFillCredential(tabs, tabId, parsed, credential);
		}
		if (path === "/capture-totp") {
			return await runCaptureTotp(tabs, tabId, parsed, credential);
		}
		return await runDrag(tabs, tabId, parsed);
	} catch (e) {
		// Core's vault refusal (wrong host, another agent's account, no TOTP
		// enrolled, missing grant) is surfaced verbatim; it never carries a secret.
		if (e instanceof VaultFillError) {
			return { status: e.status, json: { ok: false, error: e.message } };
		}
		// A stale/unknown element ref is the CALLER's to fix (re-run snapshot), so it
		// is a 400 carrying that instruction — never a blind 500, and never a silent
		// fallback to some other element.
		if (e instanceof RefError) {
			return { status: 400, json: { ok: false, error: e.message } };
		}
		return {
			status: 500,
			json: {
				ok: false,
				error: e instanceof Error ? e.message : "browser control failed",
			},
		};
	}
}
