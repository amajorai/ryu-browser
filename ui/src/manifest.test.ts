import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

interface HttpRoute {
	path: string;
}
interface Sidecar {
	health_path?: string;
	http?: { routes?: HttpRoute[] };
	name: string;
	port?: number;
	process?: Record<string, unknown>;
}
interface Provide {
	capability: string;
	grant: string;
	route: string;
	sidecar: string;
	version?: string;
}
interface Manifest {
	id: string;
	name: string;
	permission_grants?: string[];
	provides?: Provide[];
	sidecars?: Sidecar[];
	version: string;
}

// Reading + JSON.parse here also proves the shipped file is present and valid
// JSON — a corrupt manifest fails Core's `include_str!`-mirrored registration.
// import.meta.dir is `<app>/ui/src`; the manifest lives at `<app>/manifest.json`.
const manifestPath = join(dirname(dirname(import.meta.dir)), "manifest.json");
const raw = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(raw) as Manifest;

describe("browser manifest.json manifest contract", () => {
	it("parses and declares the reserved browser id + version", () => {
		expect(manifest.id).toBe("com.ryu.browser");
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
			const routes = ((sc as Sidecar).http?.routes ?? []).map((r) => r.path);
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

	it("declares no permission_grant that no capability consumes", () => {
		const usedGrants = new Set((manifest.provides ?? []).map((p) => p.grant));
		for (const g of manifest.permission_grants ?? []) {
			expect(usedGrants.has(g)).toBe(true);
		}
	});
});
