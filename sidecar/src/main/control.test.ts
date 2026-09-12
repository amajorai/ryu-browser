import { describe, expect, it } from "bun:test";
import {
	bearerOk,
	handleRequest,
	isJsonContentType,
	isTrustedLocalRequest,
	resolveControlPort,
	resolveControlToken,
} from "./control.ts";
import {
	type ActionResult,
	type BrowserAnnotation,
	type BrowserAnnotationInput,
	type BrowserContextRequest,
	type BrowserContextResult,
	type BrowserCoordinateAction,
	type BrowserMouseButton,
	type BrowserWebMCPTool,
	RefError,
	type ScrollDirection,
	type SnapshotResult,
	type TabInfo,
	type TabManager,
} from "./tab-manager.ts";
import { WebMCPError } from "./webmcp.ts";

/** What the fake recorded for the last synthetic-input call. */
interface RecordedAction {
	amount?: number;
	direction?: ScrollDirection;
	kind: "click" | "scroll" | "type";
	ref?: string;
	replace?: boolean;
	submit?: boolean;
	tabId: string;
	text?: string;
}

// A pure in-memory TabManager so the control routing/auth is exercised with no
// Electron and no sockets.
class FakeTabManager implements TabManager {
	private tabs: TabInfo[] = [];
	private seq = 0;
	private active: string | null = null;
	public lastEval: { id: string; expression: string } | null = null;
	public evalThrows = false;
	public lastAction: RecordedAction | null = null;
	public lastAnnotation: BrowserAnnotationInput | null = null;
	/** Refs the fake "knows"; anything else raises RefError like the real manager. */
	public knownRefs = new Set<string>(["@e1"]);
	public controlThrows: Error | null = null;
	public webmcp: BrowserWebMCPTool[] = [
		{
			annotations: { readOnlyHint: false, untrustedContentHint: true },
			description: "Add an item to the page.",
			input_schema: '{"type":"object","properties":{"text":{"type":"string"}}}',
			name: "add_item",
			origin: "https://a.test",
			title: "Add item",
		},
	];
	public lastWebMCP: {
		id: string;
		input: Record<string, unknown>;
		name: string;
	} | null = null;

	list(): TabInfo[] {
		return this.tabs.map((t) => ({ ...t }));
	}
	activeId(): string | null {
		return this.active;
	}
	open(url: string): TabInfo {
		this.seq += 1;
		const tab: TabInfo = { id: `t${this.seq}`, url, title: `Tab ${this.seq}` };
		this.tabs.push(tab);
		this.active = tab.id;
		return { ...tab };
	}
	close(id: string): boolean {
		const before = this.tabs.length;
		this.tabs = this.tabs.filter((t) => t.id !== id);
		if (this.active === id) {
			this.active = this.tabs.at(-1)?.id ?? null;
		}
		return this.tabs.length < before;
	}

	private require(id: string): TabInfo | null {
		if (this.controlThrows) {
			throw this.controlThrows;
		}
		return this.tabs.find((t) => t.id === id) ?? null;
	}

	async snapshot(id: string): Promise<SnapshotResult | null> {
		const tab = this.require(id);
		if (!tab) {
			return null;
		}
		this.active = id;
		return {
			elements: [{ depth: 0, name: "Sign in", ref: "@e1", role: "button" }],
			snapshot_id: "snap-1",
			tab: { ...tab },
			truncated: false,
		};
	}
	async context(
		id: string,
		_request?: BrowserContextRequest
	): Promise<BrowserContextResult | null> {
		const tab = this.require(id);
		if (!tab) {
			return null;
		}
		this.active = id;
		return {
			annotations: [],
			page: { ...tab },
			snapshot: {
				elements: [{ depth: 0, name: "Sign in", ref: "@e1", role: "button" }],
				snapshot_id: "snap-1",
				tab: { ...tab },
				truncated: false,
			},
			webmcp_tools: [],
			viewport: { height: 800, scroll_x: 0, scroll_y: 0, width: 1200 },
		};
	}
	async webmcpTools(id: string): Promise<BrowserWebMCPTool[] | null> {
		const tab = this.require(id);
		return tab ? this.webmcp.map((tool) => ({ ...tool })) : null;
	}
	async webmcpExecute(
		id: string,
		name: string,
		input: Record<string, unknown>
	) {
		const tab = this.require(id);
		if (!tab) {
			return null;
		}
		this.lastWebMCP = { id, input, name };
		const tool = this.webmcp.find((candidate) => candidate.name === name);
		if (!tool) {
			throw new WebMCPError(`no WebMCP tool named '${name}'`, 404);
		}
		return { result: { echoed: input }, tool };
	}
	async annotate(
		id: string,
		input: BrowserAnnotationInput
	): Promise<BrowserAnnotation | null> {
		const tab = this.require(id);
		if (!tab) {
			return null;
		}
		this.lastAnnotation = input;
		return {
			comment: input.comment,
			created_at: "2026-08-19T00:00:00.000Z",
			id: "annotation-1",
			kind: input.kind,
			rect: input.rect,
			targets: [],
		};
	}
	clearAnnotations(id: string): boolean | null {
		return this.tabs.some((tab) => tab.id === id) ? true : null;
	}
	async hover(
		id: string,
		ref: string
	): Promise<BrowserCoordinateAction | null> {
		const tab = this.act(id, ref);
		return tab ? { ok: true, tab: { ...tab }, x: 10, y: 20 } : null;
	}
	async clickAt(
		id: string,
		x: number,
		y: number,
		_button: BrowserMouseButton,
		_count: number
	): Promise<BrowserCoordinateAction | null> {
		const tab = this.require(id);
		return tab ? { ok: true, tab: { ...tab }, x, y } : null;
	}
	async key(
		id: string,
		_keys: string[]
	): Promise<BrowserCoordinateAction | null> {
		const tab = this.require(id);
		return tab ? { ok: true, tab: { ...tab } } : null;
	}
	async drag(
		id: string,
		_from: { x: number; y: number },
		to: { x: number; y: number }
	): Promise<BrowserCoordinateAction | null> {
		const tab = this.require(id);
		return tab ? { ok: true, tab: { ...tab }, x: to.x, y: to.y } : null;
	}

	private act(id: string, ref: string | undefined): TabInfo | null {
		const tab = this.require(id);
		if (!tab) {
			return null;
		}
		if (ref !== undefined && !this.knownRefs.has(ref)) {
			throw new RefError(`unknown element ref '${ref}'`);
		}
		this.active = id;
		return tab;
	}

	async click(id: string, ref: string): Promise<ActionResult | null> {
		const tab = this.act(id, ref);
		if (!tab) {
			return null;
		}
		this.lastAction = { kind: "click", ref, tabId: id };
		return { ok: true, tab: { ...tab }, x: 10, y: 20 };
	}

	async type(
		id: string,
		ref: string,
		text: string,
		submit: boolean,
		replace = false
	): Promise<ActionResult | null> {
		const tab = this.act(id, ref);
		if (!tab) {
			return null;
		}
		this.lastAction = { kind: "type", ref, replace, submit, tabId: id, text };
		return { ok: true, tab: { ...tab } };
	}

	async scroll(
		id: string,
		direction: ScrollDirection,
		amount?: number
	): Promise<ActionResult | null> {
		const tab = this.act(id, undefined);
		if (!tab) {
			return null;
		}
		this.lastAction = { amount, direction, kind: "scroll", tabId: id };
		return { ok: true, tab: { ...tab } };
	}
	navigate(id: string, url: string): TabInfo | null {
		const tab = this.tabs.find((t) => t.id === id);
		if (!tab) {
			return null;
		}
		tab.url = url;
		return { ...tab };
	}
	async screenshot(id: string): Promise<string | null> {
		return this.tabs.some((t) => t.id === id) ? "iVBORw0KGgo=" : null;
	}
	async eval(id: string, expression: string): Promise<unknown> {
		this.lastEval = { id, expression };
		if (this.evalThrows) {
			throw new Error("boom");
		}
		return { echoed: expression };
	}
	title(id: string): string | null {
		return this.tabs.find((t) => t.id === id)?.title ?? null;
	}
}

const TOKEN = "secret-token";
const AUTH = `Bearer ${TOKEN}`;
const JSON_CT = "application/json";

function deps(
	tabs: TabManager = new FakeTabManager(),
	token: string | null = TOKEN
) {
	return { tabs, token };
}

describe("bearerOk", () => {
	it("rejects when no expected token is configured (fail-closed)", () => {
		expect(bearerOk(AUTH, null)).toBe(false);
		expect(bearerOk(AUTH, "")).toBe(false);
	});
	it("rejects a missing or malformed header", () => {
		expect(bearerOk(undefined, TOKEN)).toBe(false);
		expect(bearerOk(TOKEN, TOKEN)).toBe(false); // no "Bearer " prefix
	});
	it("rejects a wrong token and accepts the right one", () => {
		expect(bearerOk("Bearer nope", TOKEN)).toBe(false);
		expect(bearerOk(AUTH, TOKEN)).toBe(true);
	});
});

describe("resolveControlToken", () => {
	it("prefers RYU_EXT_TOKEN, falls back to RYU_BROWSER_TOKEN, else null", () => {
		expect(
			resolveControlToken({ RYU_EXT_TOKEN: "a" } as NodeJS.ProcessEnv)
		).toBe("a");
		expect(
			resolveControlToken({ RYU_BROWSER_TOKEN: "b" } as NodeJS.ProcessEnv)
		).toBe("b");
		expect(
			resolveControlToken({
				RYU_EXT_TOKEN: "a",
				RYU_BROWSER_TOKEN: "b",
			} as NodeJS.ProcessEnv)
		).toBe("a");
		expect(resolveControlToken({} as NodeJS.ProcessEnv)).toBeNull();
		expect(
			resolveControlToken({ RYU_EXT_TOKEN: "  " } as NodeJS.ProcessEnv)
		).toBeNull();
	});
});

describe("resolveControlPort", () => {
	it("honours explicit ports and isolates every known profile", () => {
		expect(
			resolveControlPort({ RYU_BROWSER_PORT: "9999" } as NodeJS.ProcessEnv)
		).toBe(9999);
		expect(
			resolveControlPort({ RYU_PROFILE: "dev" } as NodeJS.ProcessEnv)
		).toBe(8993);
		expect(
			resolveControlPort({ RYU_PROFILE: "canary" } as NodeJS.ProcessEnv)
		).toBe(9993);
		expect(
			resolveControlPort({ RYU_PROFILE: "nightly" } as NodeJS.ProcessEnv)
		).toBe(10_993);
		expect(
			resolveControlPort({ RYU_PROFILE: "beta" } as NodeJS.ProcessEnv)
		).toBe(11_993);
		expect(resolveControlPort({} as NodeJS.ProcessEnv)).toBe(7993);
		expect(() =>
			resolveControlPort({ RYU_PROFILE: "staging" } as NodeJS.ProcessEnv)
		).toThrow("unknown RYU_PROFILE");
	});
});

describe("handleRequest auth", () => {
	it("serves /health without a bearer", async () => {
		const resp = await handleRequest("GET", "/health", undefined, "", deps());
		expect(resp.status).toBe(200);
		expect((resp.json as { ok: boolean }).ok).toBe(true);
	});
	it("401s a protected route with no/ wrong bearer", async () => {
		expect(
			(await handleRequest("GET", "/tabs", undefined, "", deps())).status
		).toBe(401);
		expect(
			(await handleRequest("GET", "/tabs", "Bearer x", "", deps())).status
		).toBe(401);
	});
	it("fails closed when no token is configured", async () => {
		const resp = await handleRequest(
			"GET",
			"/tabs",
			AUTH,
			"",
			deps(new FakeTabManager(), null)
		);
		expect(resp.status).toBe(401);
	});
	it("blocks the protected control plane when Browser control is disabled", async () => {
		const resp = await handleRequest("GET", "/tabs", AUTH, "", {
			...deps(),
			controlEnabled: () => false,
		});
		expect(resp.status).toBe(403);
		expect((resp.json as { error: string }).error).toContain(
			"browser control is disabled"
		);
	});

	it("routes a Core-selected agent to its own tab manager", async () => {
		const userTabs = new FakeTabManager();
		const botTabs = new FakeTabManager();
		botTabs.open("https://bot-a.example");
		const response = await handleRequest(
			"GET",
			"/tabs",
			AUTH,
			"",
			{
				tabs: userTabs,
				tabsFor: (agentId) => (agentId === "agent-a" ? botTabs : null),
				token: TOKEN,
			},
			undefined,
			"agent-a"
		);
		expect(response.status).toBe(200);
		expect(response.json).toEqual({
			tabs: [{ id: "t1", title: "Tab 1", url: "https://bot-a.example" }],
		});
		expect(
			(
				await handleRequest(
					"GET",
					"/tabs",
					AUTH,
					"",
					{
						tabs: userTabs,
						tabsFor: () => null,
						token: TOKEN,
					},
					undefined,
					"agent-b"
				)
			).status
		).toBe(403);
	});

	it("does not lazily resolve a Bot session before bearer auth", async () => {
		let resolved = false;
		const response = await handleRequest(
			"GET",
			"/tabs",
			undefined,
			"",
			{
				...deps(),
				tabsFor: () => {
					resolved = true;
					return new FakeTabManager();
				},
			},
			undefined,
			"agent-a"
		);

		expect(response.status).toBe(401);
		expect(resolved).toBe(false);
	});
});

describe("handleRequest tabs lifecycle", () => {
	it("opens, lists, navigates, titles, and closes a tab", async () => {
		const tabs = new FakeTabManager();
		const d = deps(tabs);

		const opened = await handleRequest(
			"POST",
			"/tabs",
			AUTH,
			'{"url":"https://a.test"}',
			d,
			JSON_CT
		);
		expect(opened.status).toBe(201);
		const id = (opened.json as { tab: TabInfo }).tab.id;

		const listed = await handleRequest("GET", "/tabs", AUTH, "", d);
		expect((listed.json as { tabs: TabInfo[] }).tabs).toHaveLength(1);

		const nav = await handleRequest(
			"POST",
			`/tabs/${id}/navigate`,
			AUTH,
			'{"url":"https://b.test"}',
			d,
			JSON_CT
		);
		expect((nav.json as { tab: TabInfo }).tab.url).toBe("https://b.test");

		const title = await handleRequest("GET", `/tabs/${id}/title`, AUTH, "", d);
		expect(title.status).toBe(200);

		const closed = await handleRequest("DELETE", `/tabs/${id}`, AUTH, "", d);
		expect(closed.status).toBe(200);
		expect((await handleRequest("GET", "/tabs", AUTH, "", d)).json).toEqual({
			tabs: [],
		});
	});

	it("404s navigate/screenshot/title/delete on an unknown tab", async () => {
		const d = deps();
		expect(
			(
				await handleRequest(
					"POST",
					"/tabs/nope/navigate",
					AUTH,
					'{"url":"https://unknown.test"}',
					d,
					JSON_CT
				)
			).status
		).toBe(404);
		expect(
			(await handleRequest("POST", "/tabs/nope/screenshot", AUTH, "", d)).status
		).toBe(404);
		expect(
			(await handleRequest("GET", "/tabs/nope/title", AUTH, "", d)).status
		).toBe(404);
		expect(
			(await handleRequest("DELETE", "/tabs/nope", AUTH, "", d)).status
		).toBe(404);
	});

	it("400s navigate with a missing url", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		const resp = await handleRequest(
			"POST",
			`/tabs/${opened.id}/navigate`,
			AUTH,
			"{}",
			deps(tabs),
			JSON_CT
		);
		expect(resp.status).toBe(400);
	});

	it("rejects non-web navigation schemes", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		const d = deps(tabs);
		for (const url of ["javascript:alert(1)", "data:text/html,owned"]) {
			const response = await handleRequest(
				"POST",
				`/tabs/${opened.id}/navigate`,
				AUTH,
				JSON.stringify({ url }),
				d,
				JSON_CT
			);
			expect(response.status).toBe(400);
		}
	});
});

describe("handleRequest screenshot + eval", () => {
	it("returns a base64 png for screenshot", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		const resp = await handleRequest(
			"POST",
			`/tabs/${opened.id}/screenshot`,
			AUTH,
			"",
			deps(tabs)
		);
		expect(resp.status).toBe(200);
		expect((resp.json as { encoding: string }).encoding).toBe("base64");
	});

	it("runs privileged eval and returns the result", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		const resp = await handleRequest(
			"POST",
			`/tabs/${opened.id}/eval`,
			AUTH,
			'{"expression":"1+1"}',
			deps(tabs),
			JSON_CT
		);
		expect(resp.status).toBe(200);
		expect(tabs.lastEval?.expression).toBe("1+1");
	});

	it("400s eval with no expression and 500s when eval throws", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		expect(
			(
				await handleRequest(
					"POST",
					`/tabs/${opened.id}/eval`,
					AUTH,
					"{}",
					deps(tabs),
					JSON_CT
				)
			).status
		).toBe(400);
		tabs.evalThrows = true;
		expect(
			(
				await handleRequest(
					"POST",
					`/tabs/${opened.id}/eval`,
					AUTH,
					'{"expression":"x"}',
					deps(tabs),
					JSON_CT
				)
			).status
		).toBe(500);
	});
});

describe("handleRequest snapshot", () => {
	it("returns elements with stable refs for a known tab", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		const resp = await handleRequest(
			"POST",
			`/tabs/${opened.id}/snapshot`,
			AUTH,
			"",
			deps(tabs)
		);
		expect(resp.status).toBe(200);
		const snap = resp.json as SnapshotResult;
		expect(snap.elements[0]?.ref).toBe("@e1");
		expect(snap.snapshot_id).toBe("snap-1");
	});

	it("404s an unknown tab and 500s a CDP failure", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		expect(
			(await handleRequest("POST", "/tabs/nope/snapshot", AUTH, "", deps(tabs)))
				.status
		).toBe(404);
		tabs.controlThrows = new Error("debugger detached");
		const resp = await handleRequest(
			"POST",
			`/tabs/${opened.id}/snapshot`,
			AUTH,
			"",
			deps(tabs)
		);
		expect(resp.status).toBe(500);
		expect((resp.json as { error: string }).error).toBe("debugger detached");
	});
});

describe("handleRequest context + annotations", () => {
	it("returns structured context and persists/removes annotations", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://app.test");
		const context = await handleRequest(
			"POST",
			`/tabs/${opened.id}/context`,
			AUTH,
			JSON.stringify({
				include_screenshot: false,
				selections: [{ height: 0, width: 0, x: 20, y: 30 }],
			}),
			deps(tabs),
			JSON_CT
		);
		expect(context.status).toBe(200);
		expect((context.json as BrowserContextResult).page.id).toBe(opened.id);

		const annotation = await handleRequest(
			"POST",
			`/tabs/${opened.id}/annotations`,
			AUTH,
			JSON.stringify({
				comment: "Increase the contrast here.",
				kind: "element",
				rect: { height: 0, width: 0, x: 20, y: 30 },
			}),
			deps(tabs),
			JSON_CT
		);
		expect(annotation.status).toBe(201);
		expect(tabs.lastAnnotation?.kind).toBe("element");

		const removed = await handleRequest(
			"DELETE",
			`/tabs/${opened.id}/annotations/annotation-1`,
			AUTH,
			"",
			deps(tabs)
		);
		expect(removed.status).toBe(200);
		expect(
			(
				await handleRequest(
					"DELETE",
					`/tabs/${opened.id}/annotations`,
					AUTH,
					"",
					deps(tabs)
				)
			).status
		).toBe(200);
	});

	it("rejects malformed context and annotation input", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://app.test");
		expect(
			(
				await handleRequest(
					"POST",
					`/tabs/${opened.id}/context`,
					AUTH,
					JSON.stringify({ selections: [{ x: "bad", y: 0 }] }),
					deps(tabs),
					JSON_CT
				)
			).status
		).toBe(400);
		expect(
			(
				await handleRequest(
					"POST",
					`/tabs/${opened.id}/annotations`,
					AUTH,
					JSON.stringify({ kind: "area", rect: { x: 0, y: 0 } }),
					deps(tabs),
					JSON_CT
				)
			).status
		).toBe(400);
	});
});

describe("handleRequest WebMCP", () => {
	const post = (
		tabs: FakeTabManager,
		path: string,
		payload: unknown,
		contentType = JSON_CT
	) =>
		handleRequest(
			"POST",
			path,
			AUTH,
			JSON.stringify(payload),
			deps(tabs),
			contentType
		);

	it("lists the current tab's page-registered tools", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		const response = await handleRequest(
			"GET",
			`/tabs/${opened.id}/webmcp`,
			AUTH,
			"",
			deps(tabs)
		);
		expect(response.status).toBe(200);
		expect((response.json as { tools: BrowserWebMCPTool[] }).tools).toEqual(
			tabs.webmcp
		);
	});

	it("executes a named page tool and preserves its safety hints", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		const response = await post(tabs, `/tabs/${opened.id}/webmcp/execute`, {
			arguments: { text: "hello" },
			tool_name: "add_item",
		});
		expect(response.status).toBe(200);
		expect(response.json).toEqual({
			origin: "https://a.test",
			result: { echoed: { text: "hello" } },
			tool_name: "add_item",
			untrusted_content: true,
			untrusted_content_hint: true,
		});
		expect(tabs.lastWebMCP).toEqual({
			id: opened.id,
			input: { text: "hello" },
			name: "add_item",
		});
	});

	it("rejects invalid WebMCP names, arguments, and content types", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		expect(
			(
				await post(tabs, `/tabs/${opened.id}/webmcp/execute`, {
					tool_name: "not a valid name",
				})
			).status
		).toBe(400);
		expect(
			(
				await post(tabs, `/tabs/${opened.id}/webmcp/execute`, {
					arguments: [],
					tool_name: "add_item",
				})
			).status
		).toBe(400);
		expect(
			(
				await post(
					tabs,
					`/tabs/${opened.id}/webmcp/execute`,
					{ tool_name: "add_item" },
					"text/plain"
				)
			).status
		).toBe(415);
	});

	it("returns 404 when a listed tool becomes stale", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		tabs.webmcp = [];
		const response = await post(tabs, `/tabs/${opened.id}/webmcp/execute`, {
			tool_name: "add_item",
		});
		expect(response.status).toBe(404);
	});
});

describe("handleRequest synthetic input", () => {
	const post = (
		tabs: FakeTabManager,
		path: string,
		payload: unknown,
		ct: string | undefined = JSON_CT
	) =>
		handleRequest("POST", path, AUTH, JSON.stringify(payload), deps(tabs), ct);

	it("clicks a ref on the explicitly named tab", async () => {
		const tabs = new FakeTabManager();
		const first = tabs.open("https://a.test");
		tabs.open("https://b.test"); // second tab becomes active
		const resp = await post(tabs, "/click", { ref: "@e1", tab_id: first.id });
		expect(resp.status).toBe(200);
		expect(tabs.lastAction).toEqual({
			kind: "click",
			ref: "@e1",
			tabId: first.id,
		});
	});

	it("falls back to the active tab when tab_id is omitted", async () => {
		const tabs = new FakeTabManager();
		tabs.open("https://a.test");
		const second = tabs.open("https://b.test");
		const resp = await post(tabs, "/click", { ref: "@e1" });
		expect(resp.status).toBe(200);
		expect(tabs.lastAction?.tabId).toBe(second.id);
	});

	it("404s with a fix-it message when there is no tab at all", async () => {
		const tabs = new FakeTabManager();
		const resp = await post(tabs, "/click", { ref: "@e1" });
		expect(resp.status).toBe(404);
		expect((resp.json as { error: string }).error).toContain("POST /tabs");
	});

	it("400s a stale ref with the re-snapshot instruction, not a 500", async () => {
		const tabs = new FakeTabManager();
		tabs.open("https://a.test");
		const resp = await post(tabs, "/click", { ref: "@e99" });
		expect(resp.status).toBe(400);
		expect((resp.json as { error: string }).error).toContain("@e99");
	});

	it("types text and honours submit", async () => {
		const tabs = new FakeTabManager();
		tabs.open("https://a.test");
		expect(
			(await post(tabs, "/type", { ref: "@e1", submit: true, text: "hi" }))
				.status
		).toBe(200);
		expect(tabs.lastAction).toMatchObject({
			kind: "type",
			submit: true,
			text: "hi",
		});
		// `submit` defaults to false rather than being forwarded as undefined.
		await post(tabs, "/type", { ref: "@e1", text: "" });
		expect(tabs.lastAction?.submit).toBe(false);
	});

	it("forwards replace, defaulting it to append", async () => {
		const tabs = new FakeTabManager();
		tabs.open("https://a.test");
		// Insertion happens at the caret, so a field that already has a value ends
		// up with BOTH unless the caller asks to replace. Defaulting to append keeps
		// the existing chromium.type contract; `replace` is the opt-in.
		await post(tabs, "/type", { ref: "@e1", text: "hi" });
		expect(tabs.lastAction?.replace).toBe(false);

		await post(tabs, "/type", { ref: "@e1", replace: true, text: "hi" });
		expect(tabs.lastAction?.replace).toBe(true);

		// Only a real `true` counts — a truthy string must not silently enable a
		// destructive overwrite.
		await post(tabs, "/type", { ref: "@e1", replace: "yes", text: "hi" });
		expect(tabs.lastAction?.replace).toBe(false);
	});

	it("400s type/click with missing fields", async () => {
		const tabs = new FakeTabManager();
		tabs.open("https://a.test");
		expect((await post(tabs, "/click", {})).status).toBe(400);
		expect((await post(tabs, "/type", { ref: "@e1" })).status).toBe(400);
		expect((await post(tabs, "/type", { text: "hi" })).status).toBe(400);
	});

	it("scrolls in a validated direction with an optional amount", async () => {
		const tabs = new FakeTabManager();
		tabs.open("https://a.test");
		expect(
			(await post(tabs, "/scroll", { amount: 250, direction: "down" })).status
		).toBe(200);
		expect(tabs.lastAction).toMatchObject({ amount: 250, direction: "down" });
		await post(tabs, "/scroll", { direction: "up" });
		expect(tabs.lastAction?.amount).toBeUndefined();
	});

	it("400s a bogus direction or amount", async () => {
		const tabs = new FakeTabManager();
		tabs.open("https://a.test");
		expect(
			(await post(tabs, "/scroll", { direction: "sideways" })).status
		).toBe(400);
		expect((await post(tabs, "/scroll", {})).status).toBe(400);
		expect(
			(await post(tabs, "/scroll", { amount: -5, direction: "down" })).status
		).toBe(400);
	});

	it("clamps an oversized amount rather than refusing a schema-legal request", async () => {
		const tabs = new FakeTabManager();
		tabs.open("https://a.test");
		expect(
			(await post(tabs, "/scroll", { amount: 1e9, direction: "down" })).status
		).toBe(200);
		expect(tabs.lastAction?.amount).toBe(100_000);
	});

	it("415s the input routes without a JSON Content-Type, and 404s non-POST", async () => {
		const tabs = new FakeTabManager();
		tabs.open("https://a.test");
		expect(
			(await post(tabs, "/click", { ref: "@e1" }, "text/plain")).status
		).toBe(415);
		expect(
			(await handleRequest("GET", "/click", AUTH, "", deps(tabs))).status
		).toBe(404);
	});

	it("requires a bearer like every other protected route", async () => {
		const tabs = new FakeTabManager();
		tabs.open("https://a.test");
		expect(
			(
				await handleRequest(
					"POST",
					"/click",
					undefined,
					'{"ref":"@e1"}',
					deps(tabs),
					JSON_CT
				)
			).status
		).toBe(401);
	});

	it("500s a genuine CDP failure (not a caller mistake)", async () => {
		const tabs = new FakeTabManager();
		tabs.open("https://a.test");
		tabs.controlThrows = new Error("debugger detached");
		const resp = await post(tabs, "/scroll", { direction: "down" });
		expect(resp.status).toBe(500);
	});
});

describe("isTrustedLocalRequest", () => {
	const PORT = 7993;
	const trusted = (headers: Record<string, string | undefined>) =>
		isTrustedLocalRequest({ headers } as never, PORT);

	it("rejects any non-empty Origin header (browser CSRF)", () => {
		expect(
			trusted({ origin: "https://evil.example", host: `127.0.0.1:${PORT}` })
		).toBe(false);
		expect(trusted({ origin: "null", host: `127.0.0.1:${PORT}` })).toBe(false);
	});
	it("rejects a non-loopback or missing Host (DNS rebinding)", () => {
		expect(trusted({ host: `attacker.example:${PORT}` })).toBe(false);
		expect(trusted({ host: "127.0.0.1:9999" })).toBe(false);
		expect(trusted({})).toBe(false);
	});
	it("accepts a plain local request naming the exact loopback endpoint", () => {
		expect(trusted({ host: `127.0.0.1:${PORT}` })).toBe(true);
		expect(trusted({ host: `localhost:${PORT}` })).toBe(true);
	});
});

describe("isJsonContentType", () => {
	it("accepts application/json with or without charset parameters", () => {
		expect(isJsonContentType("application/json")).toBe(true);
		expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
		expect(isJsonContentType("Application/JSON;charset=UTF-8")).toBe(true);
	});
	it("rejects missing or non-JSON content types", () => {
		expect(isJsonContentType(undefined)).toBe(false);
		expect(isJsonContentType("")).toBe(false);
		expect(isJsonContentType("text/plain")).toBe(false);
	});
});

describe("handleRequest content-type gate", () => {
	it("415s body-parsing POST routes without an application/json Content-Type", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		const d = deps(tabs);
		expect(
			(await handleRequest("POST", "/tabs", AUTH, '{"url":"x"}', d)).status
		).toBe(415);
		expect(
			(
				await handleRequest(
					"POST",
					`/tabs/${opened.id}/navigate`,
					AUTH,
					'{"url":"x"}',
					d,
					"text/plain"
				)
			).status
		).toBe(415);
		expect(
			(
				await handleRequest(
					"POST",
					`/tabs/${opened.id}/eval`,
					AUTH,
					'{"expression":"1"}',
					d,
					"text/plain"
				)
			).status
		).toBe(415);
	});
	it("rejects JSON arrays where an object body is required", async () => {
		const resp = await handleRequest(
			"POST",
			"/tabs",
			AUTH,
			"[]",
			deps(),
			JSON_CT
		);
		expect(resp.status).toBe(400);
	});
	it("leaves the body-less screenshot POST exempt", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		const resp = await handleRequest(
			"POST",
			`/tabs/${opened.id}/screenshot`,
			AUTH,
			"",
			deps(tabs)
		);
		expect(resp.status).toBe(200);
	});
});

describe("browser capability bridge", () => {
	const call = (
		tabs: TabManager,
		tool: string,
		args: Record<string, unknown> = {},
		contentType = JSON_CT
	) =>
		handleRequest(
			"POST",
			"/",
			AUTH,
			JSON.stringify({ args, tool }),
			deps(tabs),
			contentType
		);

	it("dispatches tabs, navigate, click, and snapshot through one envelope", async () => {
		const tabs = new FakeTabManager();
		const listed = await call(tabs, "browser.tabs");
		expect(listed.status).toBe(200);
		expect((listed.json as { tabs: TabInfo[] }).tabs).toEqual([]);

		const opened = await call(tabs, "browser.navigate", {
			url: "https://chatgpt.com/?temporary-chat=true",
		});
		expect(opened.status).toBe(201);
		const id = (opened.json as { tab: TabInfo }).tab.id;

		const navigated = await call(tabs, "browser.navigate_tab", {
			tab_id: id,
			url: "https://chatgpt.com/",
		});
		expect((navigated.json as { tab: TabInfo }).tab.url).toBe(
			"https://chatgpt.com/"
		);

		const clicked = await call(tabs, "browser.click", {
			ref: "@e1",
			tab_id: id,
		});
		expect(clicked.status).toBe(200);
		expect(tabs.lastAction).toMatchObject({ kind: "click", tabId: id });

		const snapshot = await call(tabs, "browser.snapshot", { tab_id: id });
		expect(snapshot.status).toBe(200);
		expect((snapshot.json as SnapshotResult).snapshot_id).toBe("snap-1");
	});

	it("dispatches context, annotations, and computer-use parity actions", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://app.test");

		const context = await call(tabs, "browser.context", {
			tab_id: opened.id,
			include_screenshot: false,
			selections: [{ height: 0, width: 0, x: 24, y: 48 }],
		});
		expect(context.status).toBe(200);
		expect((context.json as BrowserContextResult).viewport.width).toBe(1200);

		const annotation = await call(tabs, "browser.annotate", {
			comment: "Make this control easier to scan.",
			kind: "element",
			rect: { height: 0, width: 0, x: 24, y: 48 },
			tab_id: opened.id,
		});
		expect(annotation.status).toBe(201);
		expect(tabs.lastAnnotation?.comment).toBe(
			"Make this control easier to scan."
		);
		expect(
			(await call(tabs, "browser.clear_annotations", { tab_id: opened.id }))
				.status
		).toBe(200);

		for (const [tool, args] of [
			["browser.hover", { ref: "@e1", tab_id: opened.id }],
			["browser.click_at", { tab_id: opened.id, x: 10, y: 20 }],
			["browser.key", { keys: ["cmd", "l"], tab_id: opened.id }],
			[
				"browser.drag",
				{ from: { x: 10, y: 20 }, tab_id: opened.id, to: { x: 40, y: 80 } },
			],
		] as const) {
			expect((await call(tabs, tool, args)).status).toBe(200);
		}
	});

	it("rejects eval and malformed capability envelopes", async () => {
		const tabs = new FakeTabManager();
		tabs.open("https://chatgpt.com/");
		expect((await call(tabs, "browser.eval")).status).toBe(400);
		expect((await call(tabs, "browser.tabs", {}, "text/plain")).status).toBe(
			415
		);
		expect(
			(
				await handleRequest(
					"POST",
					"/",
					AUTH,
					JSON.stringify({ args: {}, tool: "browser.navigate_tab" }),
					deps(tabs),
					JSON_CT
				)
			).status
		).toBe(400);
	});
});

describe("handleRequest misc", () => {
	it("serves the capability root with auth", async () => {
		const resp = await handleRequest("GET", "/", AUTH, "", deps());
		expect(resp.status).toBe(200);
		expect((resp.json as { capability: string }).capability).toBe(
			"browser.control"
		);
	});
	it("404s an unknown path", async () => {
		expect((await handleRequest("GET", "/nope", AUTH, "", deps())).status).toBe(
			404
		);
	});
});
