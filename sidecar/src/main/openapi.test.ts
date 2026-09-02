import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { handleRequest } from "./control.ts";
import { OPENAPI_DOCUMENT } from "./openapi.ts";
import type { TabInfo, TabManager } from "./tab-manager.ts";

const TOKEN = "tok";
const AUTH = `Bearer ${TOKEN}`;

/** Only `list()` is reachable from the routes under test; the rest must not be hit. */
const inertTabs = {
	list: (): TabInfo[] => [],
	activeId: () => null,
} as unknown as TabManager;

function deps() {
	return { tabs: inertTabs, token: TOKEN };
}

interface Manifest {
	runnables: { config: { method: string; url: string } }[];
	sidecars: { http?: { mount?: string; routes?: { path: string }[] } }[];
}

function manifest(): Manifest {
	return JSON.parse(
		readFileSync(new URL("../../../manifest.json", import.meta.url), "utf8")
	) as Manifest;
}

/**
 * The ext-proxy's own matcher, ported: `:param` matches one non-empty segment and a
 * trailing `*rest` matches the remainder. Core runs the real one
 * (`ext_proxy::route_matches`) over the same two inputs, so a document path this
 * rejects is a derived tool Core would silently drop.
 */
function routeMatches(pattern: string, actual: string): boolean {
	const pat = pattern.replace(/^\//, "").split("/");
	const act = actual.replace(/^\//, "").split("/");
	for (const [i, p] of pat.entries()) {
		if (p.startsWith("*")) {
			return true;
		}
		const a = act[i];
		if (a === undefined) {
			return false;
		}
		if (p.startsWith(":")) {
			if (a === "") {
				return false;
			}
		} else if (p !== a) {
			return false;
		}
	}
	return pat.length === act.length;
}

/** The sub-paths the manifest's hand-written `chromium.*` runnables already serve. */
function runnablePaths(): Set<string> {
	const prefix = "core:/api/ext/@ryu/browser";
	return new Set(
		manifest()
			.runnables.map((r) => r.config.url)
			.filter((u) => u.startsWith(prefix))
			.map((u) => u.slice(prefix.length) || "/")
	);
}

describe("openapi document routing", () => {
	it("serves the document to an authenticated caller", async () => {
		const resp = await handleRequest("GET", "/openapi.json", AUTH, "", deps());
		expect(resp.status).toBe(200);
		expect((resp.json as { openapi: string }).openapi).toBe("3.0.3");
	});

	// Behind the bearer like every route but `/health`. Core's importer presents the
	// minted ext_token; a drive-by local process does not.
	it("401s an unauthenticated document fetch", async () => {
		const resp = await handleRequest(
			"GET",
			"/openapi.json",
			undefined,
			"",
			deps()
		);
		expect(resp.status).toBe(401);
	});
});

describe("openapi document contract", () => {
	// Core intersects derived operations against the manifest's declared routes and
	// DROPS whatever does not match, logging only at debug. A path documented here
	// but undeclared there therefore yields nothing, silently.
	it("only documents paths the manifest declares", () => {
		const declared = (manifest().sidecars[0].http?.routes ?? []).map(
			(r) => r.path
		);
		expect(declared.length).toBeGreaterThan(0);
		const documented = Object.keys(OPENAPI_DOCUMENT.paths);
		expect(documented.length).toBeGreaterThan(0);
		for (const route of documented) {
			expect(
				declared.some((pattern) => routeMatches(pattern, route)),
				`${route} is documented but not declared in manifest http.routes`
			).toBe(true);
		}
	});

	// The reason this document is deliberately thin. Every tab/capture/input route
	// already ships as a hand-written `chromium.*` runnable whose description carries
	// semantics no schema can express (optional `tab_id`, append-vs-replace typing,
	// stale-ref recovery) and which fails open when the browser is down. Documenting
	// one of them here would mint a second, worse-described tool for the same action
	// and leave the model choosing between them on every step.
	it("documents nothing the hand-written runnables already cover", () => {
		const covered = runnablePaths();
		for (const route of Object.keys(OPENAPI_DOCUMENT.paths)) {
			// Runnable urls use the same `{id}` brace form as the document, so this is
			// a literal comparison, not a pattern match.
			expect(
				covered.has(route),
				`${route} duplicates an existing chromium.* runnable`
			).toBe(false);
		}
	});

	// `POST /tabs/:id/eval` runs arbitrary JS in a live page's web contents, carrying
	// whatever the user's browser is signed in to. The app exposes no runnable for it;
	// documenting it here would hand that capability to the model as a side effect of
	// a schema change. Expanding the agent's reach is a product decision, so it must
	// be made in the manifest with a description that states the cost — never here.
	it("does not expose the privileged eval route", () => {
		expect(Object.keys(OPENAPI_DOCUMENT.paths)).not.toContain(
			"/tabs/{id}/eval"
		);
	});

	// Nothing in this document takes a body today, and if that ever changes the write
	// route must carry a real schema: Core merges a requestBody's named properties
	// into the derived tool's `input_schema`, and an untyped body yields a tool the
	// model can call but has no arguments to fill in.
	it("gives every write route a real request body schema", () => {
		const paths = OPENAPI_DOCUMENT.paths as Record<
			string,
			Record<string, { requestBody?: unknown }>
		>;
		for (const [route, item] of Object.entries(paths)) {
			for (const method of ["post", "put", "patch", "delete"]) {
				const op = item[method];
				if (!op?.requestBody) {
					continue;
				}
				const schema = (
					op.requestBody as {
						content?: Record<string, { schema?: Record<string, unknown> }>;
					}
				).content?.["application/json"]?.schema;
				expect(
					schema?.$ref !== undefined || schema?.properties !== undefined,
					`a derived write tool would have no arguments: ${route} ${method}`
				).toBe(true);
			}
		}
	});
});
