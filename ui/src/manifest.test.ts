import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

// ── Why this is a contract test, not a pure-logic module test ────────────────
// The Browser app has NO companion UI in this satellite tree: `browser/ui` is
// empty by design. Its user surface is the desktop workspace `TabKind` panel
// (apps/desktop), which drives the Electron sidecar (browser/sidecar) through
// the generic ext-proxy — there is no HTML companion here to co-locate a
// pure-logic test with. The one real artifact this package owns a stake in is
// the shipped `manifest.json` manifest: the ext-proxy, Core's lazy-spawn, the
// grant gate, and the desktop panel's feature-detection all depend on its
// cross-field referential integrity. So we validate the REAL on-disk manifest.
//
// Self-contained on purpose: we read only `../../manifest.json` (the satellite's
// own tree) — never `apps/core/**/browser.manifest.json`, which will not exist
// when this app is mirrored to `amajorai/ryu-browser` and built standalone.

/** The on-disk fields this manifest integrity suite consumes. */
const manifestContractProjectionSchema = z.object({
	id: z.string(),
	name: z.string(),
	version: z.string(),
	permission_grants: z.array(z.string()).optional(),
	provides: z
		.array(
			z.object({
				capability: z.string(),
				grant: z.string(),
				route: z.string(),
				sidecar: z.string(),
				version: z.string().optional(),
			})
		)
		.optional(),
	runnables: z
		.array(
			z.object({
				config: z
					.object({
						backend: z.string().optional(),
						slug: z.string().optional(),
						url: z.string().optional(),
					})
					.optional(),
			})
		)
		.optional(),
	sidecars: z
		.array(
			z.object({
				name: z.string(),
				health_path: z.string().optional(),
				host_api: z.object({ grants: z.array(z.string()) }).optional(),
				port: z.number().optional(),
				http: z
					.object({
						routes: z.array(z.object({ path: z.string() })).optional(),
					})
					.optional(),
				process: z
					.object({
						kind: z.literal("local"),
						command: z.string(),
						command_env: z.string().optional(),
						port_env: z.string().optional(),
					})
					.optional(),
			})
		)
		.optional(),
});

// Reading + JSON.parse here also proves the shipped file is present and valid
// JSON — a corrupt manifest fails Core's `include_str!`-mirrored registration.
// import.meta.dir is `<app>/ui/src`; the manifest lives at `<app>/manifest.json`.
const manifestPath = join(dirname(dirname(import.meta.dir)), "manifest.json");
const raw = readFileSync(manifestPath, "utf8");
const manifest = manifestContractProjectionSchema.parse(JSON.parse(raw));

describe("browser manifest.json manifest contract", () => {
	it("parses and declares the reserved browser id + version", () => {
		expect(manifest.id).toBe("@ryu/browser");
		// A semver-shaped version string is what Core/engines gate on.
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("declares at least one sidecar and one capability", () => {
		expect(Array.isArray(manifest.sidecars)).toBe(true);
		expect(manifest.sidecars?.length ?? 0).toBeGreaterThan(0);
		expect(Array.isArray(manifest.provides)).toBe(true);
		expect(manifest.provides?.length ?? 0).toBeGreaterThan(0);
	});

	it("gives every sidecar a unique name, a finite port, and a health route", () => {
		const sidecars = manifest.sidecars ?? [];
		const seen = new Set<string>();
		for (const sc of sidecars) {
			expect(sc.name.length).toBeGreaterThan(0);
			expect(seen.has(sc.name)).toBe(false);
			seen.add(sc.name);

			expect(Number.isFinite(sc.port)).toBe(true);
			expect(sc.port).toBeGreaterThan(0);

			// health_path must be one of the sidecar's declared http routes —
			// otherwise Core's readiness probe hits an unrouted 404 forever.
			const routes = (sc.http?.routes ?? []).map((r) => r.path);
			if (sc.health_path) {
				expect(routes).toContain(sc.health_path);
			}
		}
	});

	it("wires every capability to a real sidecar whose routes include its route", () => {
		const byName = new Map((manifest.sidecars ?? []).map((s) => [s.name, s]));
		for (const p of manifest.provides ?? []) {
			// provides[].sidecar must resolve to a declared sidecar name.
			const sc = byName.get(p.sidecar);
			expect(sc).toBeDefined();

			// The capability's mount route must be an actual route on that
			// sidecar — the ext-proxy forwards `/api/ext/<id>/<route>` to it.
			if (sc === undefined) {
				throw new Error(`Missing sidecar ${p.sidecar}`);
			}
			const routes = (sc.http?.routes ?? []).map((r) => r.path);
			expect(routes).toContain(p.route);

			expect(p.capability.length).toBeGreaterThan(0);
		}
	});

	it("backs every capability grant with a declared permission_grant", () => {
		const grants = new Set(manifest.permission_grants ?? []);
		expect(grants.size).toBeGreaterThan(0);
		for (const p of manifest.provides ?? []) {
			// A capability whose grant is not in permission_grants is ungrantable:
			// Core would advertise a capability nothing can ever be granted for.
			expect(grants.has(p.grant)).toBe(true);
		}
	});

	it("declares no permission_grant that no capability or tool consumes", () => {
		const usedGrants = new Set((manifest.provides ?? []).map((p) => p.grant));
		// A sidecar's `host_api.grants` consume a grant directly (the Browser
		// sidecar fills vault credentials through the host API).
		for (const sidecar of manifest.sidecars ?? []) {
			for (const grant of sidecar.host_api?.grants ?? []) {
				usedGrants.add(grant);
			}
		}
		for (const runnable of manifest.runnables ?? []) {
			if (runnable.config?.backend !== "http" || !runnable.config.url) {
				continue;
			}
			const host = runnable.config.url.startsWith("core:")
				? "127.0.0.1"
				: new URL(runnable.config.url).hostname;
			usedGrants.add(`tool:http-egress:${host}`);
		}
		for (const g of manifest.permission_grants ?? []) {
			expect(usedGrants.has(g)).toBe(true);
		}
	});

	it("declares the WebMCP discovery and execution contract", () => {
		const browser = manifest.sidecars?.find(
			(sidecar) => sidecar.name === "browser"
		);
		expect(browser).toBeDefined();
		const routes = new Set(
			(browser?.http?.routes ?? []).map((route) => route.path)
		);
		expect(routes.has("/tabs/:id/webmcp")).toBe(true);
		expect(routes.has("/tabs/:id/webmcp/execute")).toBe(true);

		const slugs = new Set(
			(manifest.runnables ?? [])
				.map((runnable) => runnable.config?.slug)
				.filter((slug) => slug !== undefined)
		);
		expect(slugs.has("chromium.list_webmcp_tools")).toBe(true);
		expect(slugs.has("chromium.execute_webmcp_tool")).toBe(true);
	});
});
