import { randomUUID } from "node:crypto";
import { buildSnapshot } from "./ax-snapshot.ts";
import {
	browserCDPAcknowledgementSchema,
	browserCDPAXTreeSchema,
	browserCDPInspectionSchema,
	browserCDPNodeLocationSchema,
} from "./cdp-records.ts";
import {
	type BrowserAnnotation,
	type BrowserAnnotationInput,
	type BrowserContextRequest,
	type BrowserContextResult,
	type BrowserElementContext,
	type BrowserRect,
	type BrowserWebMCPTool,
	RefError,
	type SnapshotResult,
} from "./tab-manager.ts";
import { TabPageOps } from "./tab-page-ops.ts";
import {
	annotationStyle,
	finiteCoordinate,
	INSPECTION_STYLE_PROPERTIES,
	type InspectedElement,
	type LiveTab,
	MAX_ANNOTATION_COMMENT_LENGTH,
	MAX_CONTEXT_SELECTIONS,
	normalizeRect,
	unionRects,
} from "./tab-support.ts";
/** Layer of `ElectronTabManager`; see `electron-tab-manager.ts`. */
export class TabInspection extends TabPageOps {
	async snapshot(id: string): Promise<SnapshotResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		await this.cdp(tab, "DOM.enable", browserCDPAcknowledgementSchema);
		// "Enables the accessibility domain which causes AXNodeIds to remain
		// consistent between method calls" — we key refs off `backendDOMNodeId`
		// regardless, but the domain must be on for `getFullAXTree`.
		await this.cdp(
			tab,
			"Accessibility.enable",
			browserCDPAcknowledgementSchema
		);
		const { nodes } = await this.cdp(
			tab,
			"Accessibility.getFullAXTree",
			browserCDPAXTreeSchema
		);
		const built = buildSnapshot(nodes ?? []);
		tab.refs = built.refs;
		tab.snapshotId = randomUUID();
		return {
			elements: built.elements,
			snapshot_id: tab.snapshotId,
			tab: this.info(tab),
			truncated: built.truncated,
		};
	}

	async context(
		id: string,
		request: BrowserContextRequest = {}
	): Promise<BrowserContextResult | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const snapshot = await this.snapshot(id);
		if (!snapshot) {
			return null;
		}
		const selections = (request.selections ?? [])
			.slice(0, MAX_CONTEXT_SELECTIONS)
			.map(normalizeRect)
			.filter((rect): rect is BrowserRect => rect !== null);
		const targets = await this.inspectSelections(tab, selections);
		const viewport = await this.viewportMetrics(tab);
		let webmcpTools: BrowserWebMCPTool[] = [];
		try {
			webmcpTools = await this.inspectWebMCP(tab);
		} catch {
			// WebMCP is an optional page capability; a page that has navigated while
			// context is being assembled should still yield its regular observation.
		}
		const result: BrowserContextResult = {
			annotations: tab.annotations,
			page: this.info(tab),
			snapshot,
			webmcp_tools: webmcpTools,
			viewport,
		};
		if (selections.length > 0) {
			result.selection = {
				rect: unionRects(selections) ?? selections[0],
				targets,
			};
		}
		if (request.include_screenshot !== false) {
			const image = await tab.view.webContents.capturePage();
			result.screenshot = {
				encoding: "base64",
				image: image.toPNG().toString("base64"),
				mime: "image/png",
			};
		}
		return result;
	}

	async annotate(
		id: string,
		input: BrowserAnnotationInput
	): Promise<BrowserAnnotation | null> {
		const tab = this.focusForControl(id);
		if (!tab) {
			return null;
		}
		const rect = normalizeRect(input.rect);
		if (!rect) {
			throw new RefError("annotation rect is invalid");
		}
		const selections = (input.selections ?? [rect])
			.slice(0, MAX_CONTEXT_SELECTIONS)
			.map(normalizeRect)
			.filter((selection): selection is BrowserRect => selection !== null);
		const targets = await this.inspectSelections(tab, selections);
		const targetRects = targets.map((target) => target.rect);
		const storedRect =
			input.kind === "element" && targets.length === 1
				? targets[0].rect
				: input.kind === "elements" && targetRects.length > 0
					? (unionRects(targetRects) ?? rect)
					: rect;
		const annotation: BrowserAnnotation = {
			comment: input.comment.trim().slice(0, MAX_ANNOTATION_COMMENT_LENGTH),
			created_at: new Date().toISOString(),
			id: randomUUID(),
			kind: input.kind,
			rect: storedRect,
			targets,
		};
		const style = annotationStyle(input.style);
		if (style) {
			annotation.style = style;
		}
		tab.annotations = [...tab.annotations, annotation];
		return annotation;
	}

	clearAnnotations(id: string, annotationId?: string): boolean | null {
		const tab = this.find(id);
		if (!tab) {
			return null;
		}
		if (!annotationId) {
			tab.annotations = [];
			return true;
		}
		const next = tab.annotations.filter(
			(annotation) => annotation.id !== annotationId
		);
		const removed = next.length !== tab.annotations.length;
		tab.annotations = next;
		return removed;
	}

	protected async inspectSelections(
		tab: LiveTab,
		selections: BrowserRect[]
	): Promise<BrowserElementContext[]> {
		if (selections.length === 0) {
			return [];
		}
		await this.cdp(tab, "DOM.enable", browserCDPAcknowledgementSchema);
		const inspected: InspectedElement[] = [];
		for (const rect of selections) {
			const points =
				rect.width === 0 && rect.height === 0
					? [{ x: rect.x, y: rect.y }]
					: [
							{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
							{ x: rect.x + 1, y: rect.y + 1 },
							{ x: rect.x + Math.max(0, rect.width - 1), y: rect.y + 1 },
						];
			for (const point of points) {
				const element = await this.inspectPoint(tab, point.x, point.y);
				if (!element) {
					continue;
				}
				if (
					!inspected.some(
						(existing) =>
							existing.selector === element.selector &&
							existing.xpath === element.xpath
					)
				) {
					inspected.push(element);
				}
			}
		}
		return inspected.map((element) => this.publicElement(tab, element));
	}

	protected async inspectPoint(
		tab: LiveTab,
		x: number,
		y: number
	): Promise<InspectedElement | null> {
		let location: { backendNodeId?: number };
		try {
			location = await this.cdp(
				tab,
				"DOM.getNodeForLocation",
				browserCDPNodeLocationSchema,
				{
					includeUserAgentShadowDOM: true,
					x,
					y,
				}
			);
		} catch {
			return null;
		}
		if (location.backendNodeId === undefined) {
			return null;
		}
		const expression = `(() => {
			const x = ${JSON.stringify(x)};
			const y = ${JSON.stringify(y)};
			const root = document.elementFromPoint(x, y);
			if (!(root instanceof Element)) return null;
			const cssEscape = (value) => {
				if (globalThis.CSS && typeof CSS.escape === "function") return CSS.escape(value);
				return value.replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
			};
			const selectorFor = (element) => {
				const parts = [];
				let current = element;
				let depth = 0;
				while (current instanceof Element && depth < 8) {
					if (current.id) {
						parts.unshift("#" + cssEscape(current.id));
						break;
					}
					let part = current.tagName.toLowerCase();
					const classes = Array.from(current.classList).slice(0, 2);
					if (classes.length) part += classes.map((name) => "." + cssEscape(name)).join("");
					const parent = current.parentElement;
					if (parent) {
						const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === current.tagName);
						if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
					}
					parts.unshift(part);
					current = current.parentElement;
					depth += 1;
				}
				return parts.join(" > ");
			};
			const xpathFor = (element) => {
				const parts = [];
				let current = element;
				while (current instanceof Element) {
					let index = 1;
					let sibling = current.previousElementSibling;
					while (sibling) {
						if (sibling.tagName === current.tagName) index += 1;
						sibling = sibling.previousElementSibling;
					}
					parts.unshift(current.tagName.toLowerCase() + "[" + index + "]");
					current = current.parentElement;
				}
				return "/" + parts.join("/");
			};
			const attributes = {};
			for (const attribute of Array.from(root.attributes).slice(0, 40)) {
				attributes[attribute.name] = attribute.value.slice(0, 300);
			}
			const style = getComputedStyle(root);
			const styleNames = ${JSON.stringify(INSPECTION_STYLE_PROPERTIES)};
			const computed_styles = Object.fromEntries(styleNames.map((name) => [name, style.getPropertyValue(name)]));
			const rect = root.getBoundingClientRect();
			const rawText = (root.innerText || root.textContent || "").trim();
			let component;
			let current = root;
			while (current && !component) {
				const fiberKey = Object.keys(current).find((key) => key.startsWith("__reactFiber$"));
				let fiber = fiberKey ? current[fiberKey] : null;
				for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
					const type = fiber.elementType || fiber.type;
					if (typeof type === "function") component = type.displayName || type.name;
					if (component) break;
				}
				current = current.parentElement;
			}
			return {
				attributes,
				backend_node_id: ${location.backendNodeId},
				component: typeof component === "string" ? component.slice(0, 120) : undefined,
				computed_styles,
				content_preview: rawText.slice(0, 400) || undefined,
				name: (root.getAttribute("aria-label") || root.getAttribute("title") || rawText).slice(0, 240) || undefined,
				role: root.getAttribute("role") || root.tagName.toLowerCase(),
				selector: selectorFor(root),
				tag: root.tagName.toLowerCase(),
				text: rawText.slice(0, 1000) || undefined,
				xpath: xpathFor(root),
				rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			};
		})()`;
		try {
			const evaluated = await this.cdp(
				tab,
				"Runtime.evaluate",
				browserCDPInspectionSchema,
				{ expression, returnByValue: true }
			);
			return evaluated.result?.value ?? null;
		} catch {
			return null;
		}
	}

	protected publicElement(
		tab: LiveTab,
		element: InspectedElement
	): BrowserElementContext {
		const ref = element.backend_node_id
			? [...tab.refs.entries()].find(
					([, backendNodeId]) => backendNodeId === element.backend_node_id
				)?.[0]
			: undefined;
		const { backend_node_id: _backendNodeId, ...publicElement } = element;
		return ref ? { ...publicElement, ref } : publicElement;
	}

	protected async coordinatePoint(
		tab: LiveTab,
		x: number,
		y: number
	): Promise<{ x: number; y: number }> {
		const point = { x: finiteCoordinate(x), y: finiteCoordinate(y) };
		if (point.x === null || point.y === null) {
			throw new RefError("browser coordinates must be finite numbers");
		}
		const viewport = await this.viewport(tab);
		if (
			point.x < 0 ||
			point.y < 0 ||
			point.x > viewport.width ||
			point.y > viewport.height
		) {
			throw new RefError(
				`browser coordinates (${point.x}, ${point.y}) are outside the ${viewport.width}x${viewport.height} viewport`
			);
		}
		return { x: point.x, y: point.y };
	}
}
