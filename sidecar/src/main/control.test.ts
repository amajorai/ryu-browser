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
	RefError,
	type ScrollDirection,
	type SnapshotResult,
	type TabInfo,
	type TabManager,
} from "./tab-manager.ts";

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
	/** Refs the fake "knows"; anything else raises RefError like the real manager. */
	public knownRefs = new Set<string>(["@e1"]);
	public controlThrows: Error | null = null;

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

	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
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

	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async click(id: string, ref: string): Promise<ActionResult | null> {
		const tab = this.act(id, ref);
		if (!tab) {
			return null;
		}
		this.lastAction = { kind: "click", ref, tabId: id };
		return { ok: true, tab: { ...tab }, x: 10, y: 20 };
	}

	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
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

	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
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
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
	async screenshot(id: string): Promise<string | null> {
		return this.tabs.some((t) => t.id === id) ? "iVBORw0KGgo=" : null;
	}
	// biome-ignore lint/suspicious/useAwait: async by interface; fake is synchronous.
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
	it("honours an explicit port, shifts +1000 in the dev profile, else default", () => {
		expect(
			resolveControlPort({ RYU_BROWSER_PORT: "9999" } as NodeJS.ProcessEnv)
		).toBe(9999);
		expect(
			resolveControlPort({ RYU_PROFILE: "dev" } as NodeJS.ProcessEnv)
		).toBe(8993);
		expect(resolveControlPort({} as NodeJS.ProcessEnv)).toBe(7993);
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
					'{"url":"x"}',
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
		// the existing chromium__type contract; `replace` is the opt-in.
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
