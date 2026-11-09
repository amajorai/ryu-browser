import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// Core's canonical credential verbs (`browser.fill_credential`,
// `browser.list_credentials`) name no satellite tool: this manifest maps them.
// The mapped tools must exist, `chromium.fill_credential` must reach a route
// the sidecar serves, and the manifest must require the host API that has the
// verbs and login URLs (1.21.0), so an older Core marks the app incompatible
// instead of half-working.

interface Runnable {
	config: {
		caller_agent_query?: string;
		input_schema?: { properties?: Record<string, unknown> };
		method?: string;
		slug: string;
		url?: string;
	};
}

interface Manifest {
	engines: { host_api?: string };
	provides: { capability: string; tools?: Record<string, { tool: string }> }[];
	runnables: Runnable[];
	sidecars: { http?: { routes?: { path: string }[] } }[];
	version: string;
}

const manifest = JSON.parse(
	readFileSync(new URL("../../../manifest.json", import.meta.url), "utf8")
) as Manifest;
const control = readFileSync(new URL("./control.ts", import.meta.url), "utf8");

function runnable(slug: string): Runnable["config"] {
	const found = manifest.runnables.find((entry) => entry.config.slug === slug);
	if (!found) {
		throw new Error(`${slug} is not a runnable`);
	}
	return found.config;
}

const browserControl = manifest.provides.find(
	(entry) => entry.capability === "browser.control"
);

describe("credential verb mappings", () => {
	it("maps both canonical verbs to the satellite's tools", () => {
		expect(browserControl?.tools?.["browser.fill_credential"]?.tool).toBe(
			"chromium.fill_credential"
		);
		expect(browserControl?.tools?.["browser.list_credentials"]?.tool).toBe(
			"chromium.list_accounts"
		);
	});

	it("serves each mapped tool with the calling agent", () => {
		const fill = runnable("chromium.fill_credential");
		expect(fill.caller_agent_query).toBe("agent_id");
		expect(fill.url).toBe("core:/api/ext/@ryu/browser/fill-credential");
		const routes = manifest.sidecars.flatMap((sidecar) =>
			(sidecar.http?.routes ?? []).map((route) => route.path)
		);
		expect(routes).toContain("/fill-credential");
		expect(control).toContain('path === "/fill-credential"');
		const list = runnable("chromium.list_accounts");
		expect(list.caller_agent_query).toBe("agent_id");
		expect(list.method).toBe("GET");
		expect(list.url).toBe("core:/api/vault/agent-accounts");
	});

	it("requires the host API with the verbs and login URLs", () => {
		expect(manifest.engines.host_api).toBe(">=1.21.0");
	});
});

describe("login URLs on agent accounts", () => {
	it("lets an account take login URLs at create", () => {
		const create = runnable("chromium.create_account");
		expect(create.input_schema?.properties?.submit_urls).toMatchObject({
			type: "array",
			maxItems: 4,
		});
	});

	it("sets an existing account's login URLs through Core's route", () => {
		const set = runnable("chromium.set_account_login_urls");
		expect(set.method).toBe("PUT");
		expect(set.url).toBe("core:/api/vault/agent-accounts/login-urls");
		expect(set.caller_agent_query).toBe("agent_id");
		expect(Object.keys(set.input_schema?.properties ?? {}).sort()).toEqual([
			"account",
			"submit_urls",
		]);
	});
});
