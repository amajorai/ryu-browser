import {
	handleControlAction,
	runAnnotation,
	runContext,
} from "./control-actions.ts";
import {
	badRequest,
	type ControlResponse,
	notFound,
	parseJsonBody,
	tabView,
} from "./control-parsing.ts";
import {
	browserControlBodySchema,
	browserControlString,
} from "./control-records.ts";
import { RefError, type TabManager } from "./tab-manager.ts";

/**
 * Dispatch the generic `browser.control` capability envelope.
 *
 * Core's capability broker forwards the body to the provider's declared `/`
 * route. Keeping this adapter here lets the browser remain a standalone
 * sidecar: the broker does not need provider-specific routes or clients, and
 * the adapter exposes only the finite browser verbs (never arbitrary eval).
 */
export async function handleCapabilityBridge(
	body: string,
	tabs: TabManager,
	validateNavigationUrl: (value: string) => Promise<string> | string
): Promise<ControlResponse> {
	const envelope = parseJsonBody(body);
	if (!envelope) {
		return badRequest("invalid json body");
	}
	const tool = (browserControlString(envelope.tool) ?? "").trim();
	const parsedArgs = browserControlBodySchema.safeParse(envelope.args);
	const args = parsedArgs.success ? parsedArgs.data : {};

	if (tool === "browser.tabs") {
		return { status: 200, json: { tabs: tabs.list().map(tabView) } };
	}

	if (tool === "browser.navigate") {
		const url = (browserControlString(args.url) ?? "").trim();
		if (url === "") {
			return badRequest("missing url");
		}
		let safeUrl: string;
		try {
			safeUrl = await validateNavigationUrl(url);
		} catch (error) {
			return badRequest(error instanceof Error ? error.message : "invalid url");
		}
		const tab = tabs.open(safeUrl);
		return { status: 201, json: { tab: tabView(tab) } };
	}

	const tabId = (browserControlString(args.tab_id) ?? "").trim();
	if (tool === "browser.navigate_tab") {
		if (tabId === "") {
			return badRequest("missing tab_id");
		}
		const url = (browserControlString(args.url) ?? "").trim();
		if (url === "") {
			return badRequest("missing url");
		}
		let safeUrl: string;
		try {
			safeUrl = await validateNavigationUrl(url);
		} catch (error) {
			return badRequest(error instanceof Error ? error.message : "invalid url");
		}
		const tab = tabs.navigate(tabId, safeUrl);
		return tab ? { status: 200, json: { tab: tabView(tab) } } : notFound();
	}

	if (tool === "browser.close_tab") {
		if (tabId === "") {
			return badRequest("missing tab_id");
		}
		return tabs.close(tabId) ? { status: 200, json: { ok: true } } : notFound();
	}

	if (
		tool === "browser.context" ||
		tool === "browser.annotate" ||
		tool === "browser.clear_annotations"
	) {
		if (tabId === "") {
			return badRequest("missing tab_id");
		}
		try {
			if (tool === "browser.context") {
				return await runContext(tabs, tabId, args);
			}
			if (tool === "browser.annotate") {
				return await runAnnotation(tabs, tabId, args);
			}
			const cleared = tabs.clearAnnotations(tabId);
			return cleared === null
				? notFound()
				: { status: 200, json: { ok: true, cleared } };
		} catch (error) {
			return error instanceof RefError
				? { status: 400, json: { ok: false, error: error.message } }
				: {
						status: 500,
						json: {
							ok: false,
							error:
								error instanceof Error
									? error.message
									: "browser control failed",
						},
					};
		}
	}

	if (tool === "browser.snapshot" || tool === "browser.screenshot") {
		if (tabId === "") {
			return badRequest("missing tab_id");
		}
		try {
			if (tool === "browser.snapshot") {
				const snapshot = await tabs.snapshot(tabId);
				return snapshot === null ? notFound() : { status: 200, json: snapshot };
			}
			const png = await tabs.screenshot(tabId);
			return png === null
				? notFound()
				: {
						status: 200,
						json: { image: png, encoding: "base64", mime: "image/png" },
					};
		} catch (error) {
			return {
				status: 500,
				json: {
					ok: false,
					error:
						error instanceof Error ? error.message : "browser control failed",
				},
			};
		}
	}

	if (
		tool === "browser.click" ||
		tool === "browser.type" ||
		tool === "browser.scroll" ||
		tool === "browser.hover" ||
		tool === "browser.click_at" ||
		tool === "browser.key" ||
		tool === "browser.drag"
	) {
		const path =
			tool === "browser.click"
				? "/click"
				: tool === "browser.type"
					? "/type"
					: tool === "browser.scroll"
						? "/scroll"
						: tool === "browser.hover"
							? "/hover"
							: tool === "browser.click_at"
								? "/click-at"
								: tool === "browser.key"
									? "/key"
									: "/drag";
		return handleControlAction("POST", path, args, tabs);
	}

	return badRequest(`unsupported browser capability '${tool || ""}'`);
}
