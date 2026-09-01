<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./icon-dark.png" />
    <img src="./icon-light.png" alt="Browser" width="144" />
  </picture>
</p>

<div align="center">

# Browser

</div>

A real-Chromium (Electron) browser Ryu runs as a local sidecar and exposes as the grant-gated browser.control capability: list/open/navigate tabs, screenshot, read titles, and (privileged) evaluate JS in a tab.

> **The public home of `ryu-browser`.** Source, builds, and releases live here —
> binaries for every platform are attached to each release.
>
> This tree is generated from the Ryu monorepo, so commits pushed here
> directly are replaced on the next sync. **Pull requests are welcome** —
> open them here and they are ported into the monorepo, then flow back out.
> Ryu as a whole: https://github.com/amajorai/ryu

## Install

**App:** [Install](ryu://apps/@ryu/browser) (opens the Ryu desktop app and asks you to confirm)

**CLI:**

```bash
ryu apps add @ryu/browser
```

## Source & build

The **source of record** for the Browser app: an Electron/Chromium `sidecar/`
that Ryu runs locally and exposes as the grant-gated `browser.control`
capability, plus the companion `ui/`. The UI imports Ryu's private `@ryu/ui`
design system, so the app **builds inside the amajorai/ryu monorepo
workspace** rather than standalone; the shipped bundle is the built artifact.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

## Parts

- **`sidecar/` — `ryu-browser` (out-of-process, Electron).** A standalone Electron
  app (`@ryu/browser-sidecar`) that owns a `BrowserWindow`/tab manager and a
  loopback HTTP control server. No dependency on `apps/core`; packaged by
  `electron-builder` into a version-less `ryu-browser-${os}-${arch}` artifact and
  resolved via `RYU_BROWSER_BIN` else `ryu-browser` on `PATH` (`~/.ryu/bin`).
  See `sidecar/README.md` for the full control API and packaging story.
- **`ui/` — the manifest (`manifest.json`).** No companion UI of its own; the
  desktop Browser panel is the consumer. The manifest owns the direct
  `chromium.*` HTTP tools and maps them to the stable `browser.*` capability.

## Browser shell

The sidecar is also a user-facing browser window, not only an agent endpoint. Its
Chromium shell includes tabs, a URL/search field, back/forward/reload, downloads,
find-in-page, zoom, device emulation, page screenshots, and a browser menu. The
menu opens the settings surfaces for browsing data, history, downloads, site
permissions, and the password/autofill boundary.

Browser metadata such as history and download status is persisted in the local
browser profile. Downloaded files remain on the user's machine, while passwords
are never copied into the agent control plane; password management stays with the
OS/browser credential manager. The Browser setting that controls agent access is
enforced by the sidecar control server, and the optional full-CDP developer mode
is an explicit elevated-risk setting that takes effect after restart.

## WebMCP page tools

Each content tab receives a document-start WebMCP bridge. It preserves a native
`document.modelContext` when the Chromium engine provides one, otherwise it
supplies the current imperative API and the deprecated `navigator.modelContext`
alias. Declarative `toolname`/`tooldescription` form annotations are supported as
well, including field schemas and `toolautosubmit` submissions.

The bridge keeps page callbacks inside the page's JavaScript realm. Agents first
call `chromium.list_webmcp_tools`, then call `chromium.execute_webmcp_tool` with
the exact tool name and a JSON object matching its advertised schema. Execution is
bound to the selected tab's top-level document and the existing `browser:control` grant; arbitrary
JavaScript evaluation remains a separate privileged route and is not exposed by
the WebMCP tools. Tool origin, `readOnlyHint`, and `untrustedContentHint` metadata
are returned, and WebMCP results are always marked as untrusted, so the agent can
apply the same confirmation and untrusted-content boundaries as other browser
actions.

## Manifest (`manifest.json`)

- **Sidecar:** `browser` on `:7993`, `command: "ryu-browser"`,
  `command_env: RYU_BROWSER_BIN`, `port_env: RYU_BROWSER_PORT`, `health_path:
  /health`, **`lazy: true`** with `idle_stop_secs: 300`. Declared HTTP routes:
  `/`, `/health`, `/tabs`, `/tabs/:id`, per-tab
  `navigate`/`screenshot`/`eval`/`snapshot`/`title`, WebMCP discovery and execution
  under `/tabs/:id/webmcp`, and the flat input routes `/click`, `/type`, `/scroll`.
- **Provides:** capability `browser.control` (v1.0.0) → sidecar `browser`, route
  `/`, grant `browser:control`, binding observation, annotation, and computer-use
  verbs — `browser.tabs`, `navigate`, `screenshot`, `snapshot`, `click`, `type`,
  `scroll`, `context`, `annotate`, `clear_annotations`, `hover`, `click_at`,
  `key`, and `drag`.
  (`browser.eval` is deliberately not a verb; see `docs/swappable-layers-design.md`
  §2.4.)
- **Grant:** `browser:control`.

## Auth / security

The sidecar binds **loopback only** and fail-closes: every route except
`GET /health` requires a bearer resolved as `RYU_EXT_TOKEN` (Core's per-plugin
secret, re-stamped on each proxied hop) else `RYU_BROWSER_TOKEN`. If neither is
set, protected routes reject with 401. On top of the bearer, every request is
gated against drive-by browser use of the loopback port: any non-empty `Origin`
header is rejected (403, kills CSRF), the `Host` header must be exactly
`127.0.0.1:<port>` or `localhost:<port>` (403, kills DNS rebinding), and
body-parsing POST routes require `Content-Type: application/json` (415).
Chromium's CDP port (`:9222`) is off by default. Users can enable it from the
Browser window's elevated-risk Developer mode setting; the change takes effect
after restart. `RYU_BROWSER_CDP=1` remains available as a standalone/dev launch
override.

## Swap seam

Any control server that honors the same `/tabs*` loopback contract and bearer
auth can replace the Electron sidecar without touching Core — the `command_env`
override points Core at an alternative binary. The capability, not the process, is
what the desktop panel and agents bind to.
