// The Browser sidecar's OpenAPI 3.0 document, served at `GET /openapi.json`.
//
// WHY THIS FILE EXISTS
// --------------------
// Core derives LLM tools from each app sidecar's own OpenAPI document: on the
// sidecar's first Healthy edge it fetches `http://127.0.0.1:<port>/openapi.json`
// (`apps/core/src/sidecar/manifest_sidecar.rs`, `import_openapi_once`), lowers every
// operation into a proxy-addressed tool, and intersects the result against this app's
// manifest `sidecars[].http.routes[]`. Serving the document is how a sidecar answers
// that probe at all — a 404 is classified DEFINITIVE and never re-asked for the life
// of the process, so "no document" and "a document Core could not read" look
// identical from the outside.
//
// WHY IT DOCUMENTS ALMOST NOTHING — AND WHY THAT IS THE POINT
// ----------------------------------------------------------
// `@ryu/browser` is the one app whose agent surface is already HAND-WRITTEN. The
// manifest ships 11 `runnables` (`chromium.list_tabs`, `chromium.open_tab`,
// `chromium.snapshot_tab`, `chromium.click`, …) covering every tab, input and
// capture route this sidecar serves, and they are strictly better than anything a
// derivation could produce:
//
//   * their descriptions are written against the canonical `browser.*` verbs the
//     capability facade binds them to (`provides[].tools`), including semantics no
//     schema can express — that `tab_id` may be OMITTED for the active tab, that
//     `type` APPENDS unless `replace` is set, that a stale `ref` is a 400 telling you
//     to snapshot again;
//   * they carry `fail_open: true`, so the model is told "the browser is not running"
//     instead of getting an opaque transport error.
//
// Re-deriving those same 11 operations from this document would put a second,
// worse-described tool in front of the model for every browser action — the model
// then has to choose between `chromium.click` and `ryu_ext.ryu_browser.post_click`
// on every step, and there is no upside to win from that choice. So the routes the
// runnables already cover are DELIBERATELY ABSENT here:
//
//   GET/POST /tabs · GET/DELETE /tabs/{id} · POST /tabs/{id}/navigate ·
//   POST /tabs/{id}/screenshot · GET /tabs/{id}/title · POST /tabs/{id}/snapshot ·
//   POST /click · POST /type · POST /scroll
//
// `POST /tabs/{id}/eval` is absent for a different reason. It is this sidecar's one
// PRIVILEGED route — arbitrary JS in a live page's web contents, carrying whatever
// the user's browser is signed in to — and the app deliberately exposes no runnable
// for it. Documenting it here would hand the model that capability as a side effect
// of a schema change, which is a product decision with a review step, not something
// a document edit should make. If browser-side JS evaluation is ever wanted as an
// agent tool, add it as a manifest runnable with a description that says what it
// costs, the same way the other 11 were added.
//
// What is left is the pair of routes no runnable covers: the service root and the
// liveness probe. Both are read-only, argument-free and truthful, which is exactly
// what makes them safe to derive. There are therefore no write routes in this
// document and no `requestBody` schemas — not an omission, an empty set.
//
// RULES ANY OPERATION ADDED HERE MUST OBEY
// ----------------------------------------
// 1. Its path must ALSO appear in `manifest.json`'s `sidecars[].http.routes[]`;
//    `ext_api::lower` drops anything the ext-proxy would 404, so an undeclared
//    operation becomes a tool that always fails.
// 2. Paths are written as the sidecar serves them (`/tabs/{id}`, brace form). This
//    sidecar declares no `http.mount`, so no prefix is stripped; if one is ever
//    added, every path here needs it too.
// 3. A write route needs a `requestBody` with named properties — Core merges those
//    into the tool's `input_schema`, and an untyped body yields a tool the model can
//    call but cannot fill in.

/**
 * The document. A plain literal rather than a builder: it is read by humans as the
 * app's API reference and by Core as the tool source, and both are better served by
 * something greppable than by something computed.
 */
export const OPENAPI_DOCUMENT = {
	openapi: "3.0.3",
	info: {
		title: "Ryu Browser",
		version: "1.0.0",
		description:
			"Control surface of the local real-Chromium browser sidecar. Tab management, page capture, accessibility snapshots and synthetic click/type/scroll input are exposed to agents as the app's own `chromium.*` tools rather than through this document, so only the service and liveness routes are described here.",
	},
	// No `servers` block on purpose: Core supplies the base URL
	// (`http://127.0.0.1:<port>`) at import time. Hardcoding one here would bake a
	// particular node's loopback port into the published satellite repo.
	paths: {
		"/": {
			get: {
				operationId: "service_info",
				summary: "Browser sidecar service info",
				description:
					"Identity and version of the running browser control sidecar, plus the capability it backs (`browser.control`). Use it to confirm which browser build is answering; use the `chromium.list_tabs` tool to see what is actually open in it.",
				responses: { "200": { description: "Service identity." } },
			},
		},
		"/health": {
			get: {
				operationId: "health",
				summary: "Liveness probe",
				description:
					"Report whether the local Chromium browser sidecar is up, and how many tabs it currently has open. The only unauthenticated route. Cheap enough to call before a browsing sequence to find out whether the browser needs starting, without opening a tab to find out.",
				responses: { "200": { description: "The sidecar is up." } },
			},
		},
	},
} as const;
