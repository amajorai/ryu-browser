import { describe, expect, it } from "bun:test";
import {
	bearerOk,
	handleRequest,
	resolveControlPort,
	resolveControlToken,
} from "./control.ts";
import type { TabInfo, TabManager } from "./tab-manager.ts";

// A pure in-memory TabManager so the control routing/auth is exercised with no
// Electron and no sockets.
class FakeTabManager implements TabManager {
	private tabs: TabInfo[] = [];
	private seq = 0;
	public lastEval: { id: string; expression: string } | null = null;
	public evalThrows = false;

	list(): TabInfo[] {
		return this.tabs.map((t) => ({ ...t }));
	}
	open(url: string): TabInfo {
		this.seq += 1;
		const tab: TabInfo = { id: `t${this.seq}`, url, title: `Tab ${this.seq}` };
		this.tabs.push(tab);
		return { ...tab };
	}
	close(id: string): boolean {
		const before = this.tabs.length;
		this.tabs = this.tabs.filter((t) => t.id !== id);
		return this.tabs.length < before;
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

function deps(tabs: TabManager = new FakeTabManager(), token: string | null = TOKEN) {
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
		expect(resolveControlToken({ RYU_EXT_TOKEN: "a" } as NodeJS.ProcessEnv)).toBe("a");
		expect(resolveControlToken({ RYU_BROWSER_TOKEN: "b" } as NodeJS.ProcessEnv)).toBe("b");
		expect(
			resolveControlToken({ RYU_EXT_TOKEN: "a", RYU_BROWSER_TOKEN: "b" } as NodeJS.ProcessEnv)
		).toBe("a");
		expect(resolveControlToken({} as NodeJS.ProcessEnv)).toBeNull();
		expect(resolveControlToken({ RYU_EXT_TOKEN: "  " } as NodeJS.ProcessEnv)).toBeNull();
	});
});

describe("resolveControlPort", () => {
	it("honours an explicit port, shifts +1000 in the dev profile, else default", () => {
		expect(resolveControlPort({ RYU_BROWSER_PORT: "9999" } as NodeJS.ProcessEnv)).toBe(9999);
		expect(resolveControlPort({ RYU_PROFILE: "dev" } as NodeJS.ProcessEnv)).toBe(8993);
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
		expect((await handleRequest("GET", "/tabs", undefined, "", deps())).status).toBe(401);
		expect((await handleRequest("GET", "/tabs", "Bearer x", "", deps())).status).toBe(401);
	});
	it("fails closed when no token is configured", async () => {
		const resp = await handleRequest("GET", "/tabs", AUTH, "", deps(new FakeTabManager(), null));
		expect(resp.status).toBe(401);
	});
});

describe("handleRequest tabs lifecycle", () => {
	it("opens, lists, navigates, titles, and closes a tab", async () => {
		const tabs = new FakeTabManager();
		const d = deps(tabs);

		const opened = await handleRequest("POST", "/tabs", AUTH, '{"url":"https://a.test"}', d);
		expect(opened.status).toBe(201);
		const id = (opened.json as { tab: TabInfo }).tab.id;

		const listed = await handleRequest("GET", "/tabs", AUTH, "", d);
		expect((listed.json as { tabs: TabInfo[] }).tabs).toHaveLength(1);

		const nav = await handleRequest(
			"POST",
			`/tabs/${id}/navigate`,
			AUTH,
			'{"url":"https://b.test"}',
			d
		);
		expect((nav.json as { tab: TabInfo }).tab.url).toBe("https://b.test");

		const title = await handleRequest("GET", `/tabs/${id}/title`, AUTH, "", d);
		expect(title.status).toBe(200);

		const closed = await handleRequest("DELETE", `/tabs/${id}`, AUTH, "", d);
		expect(closed.status).toBe(200);
		expect((await handleRequest("GET", "/tabs", AUTH, "", d)).json).toEqual({ tabs: [] });
	});

	it("404s navigate/screenshot/title/delete on an unknown tab", async () => {
		const d = deps();
		expect(
			(await handleRequest("POST", "/tabs/nope/navigate", AUTH, '{"url":"x"}', d)).status
		).toBe(404);
		expect((await handleRequest("POST", "/tabs/nope/screenshot", AUTH, "", d)).status).toBe(404);
		expect((await handleRequest("GET", "/tabs/nope/title", AUTH, "", d)).status).toBe(404);
		expect((await handleRequest("DELETE", "/tabs/nope", AUTH, "", d)).status).toBe(404);
	});

	it("400s navigate with a missing url", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		const resp = await handleRequest("POST", `/tabs/${opened.id}/navigate`, AUTH, "{}", deps(tabs));
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
			deps(tabs)
		);
		expect(resp.status).toBe(200);
		expect(tabs.lastEval?.expression).toBe("1+1");
	});

	it("400s eval with no expression and 500s when eval throws", async () => {
		const tabs = new FakeTabManager();
		const opened = tabs.open("https://a.test");
		expect(
			(await handleRequest("POST", `/tabs/${opened.id}/eval`, AUTH, "{}", deps(tabs))).status
		).toBe(400);
		tabs.evalThrows = true;
		expect(
			(
				await handleRequest(
					"POST",
					`/tabs/${opened.id}/eval`,
					AUTH,
					'{"expression":"x"}',
					deps(tabs)
				)
			).status
		).toBe(500);
	});
});

describe("handleRequest misc", () => {
	it("serves the capability root with auth", async () => {
		const resp = await handleRequest("GET", "/", AUTH, "", deps());
		expect(resp.status).toBe(200);
		expect((resp.json as { capability: string }).capability).toBe("browser.control");
	});
	it("404s an unknown path", async () => {
		expect((await handleRequest("GET", "/nope", AUTH, "", deps())).status).toBe(404);
	});
});
