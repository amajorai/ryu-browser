# ryu-browser

Browser for Ryu — a real-Chromium (Electron) browser Ryu runs as a local sidecar and exposes as the grant-gated browser.control capability: list/open/navigate tabs, screenshot, read titles, and (privileged) evaluate JS in a tab.

> **The public home of `ryu-browser`.** Source, builds, and releases live here —
> binaries for every platform are attached to each release.
>
> This tree is generated from the Ryu monorepo, so commits pushed here
> directly are replaced on the next sync. **Pull requests are welcome** —
> open them here and they are ported into the monorepo, then flow back out.
> Ryu as a whole: https://github.com/amajorai/ryu

## Source & build

The **source of record** for the Browser app: an Electron/Chromium `sidecar/`
that Ryu runs locally and exposes as the grant-gated `browser.control`
capability, plus the companion `ui/`. The UI imports Ryu's private `@ryu/ui`
design system, so the app **builds inside the amajorai/ryu monorepo
workspace** rather than standalone; the shipped bundle is the built artifact.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

---

# com.ryu.browser — Browser

A real-Chromium (Electron) browser Ryu runs as a **local sidecar** and exposes to
agents as the grant-gated `browser.control` capability: list/open/close/navigate
tabs, screenshot, read titles, and (privileged) evaluate JS in a tab. Core spawns
the sidecar lazily and idle-stops it; the desktop Browser panel drives it through
the ext-proxy.

## Parts

- **`sidecar/` — `ryu-browser` (out-of-process, Electron).** A standalone Electron
  app (`@ryu/browser-sidecar`) that owns a `BrowserWindow`/tab manager and a
  loopback HTTP control server. No dependency on `apps/core`; packaged by
  `electron-builder` into a version-less `ryu-browser-${os}-${arch}` artifact and
  resolved via `RYU_BROWSER_BIN` else `ryu-browser` on `PATH` (`~/.ryu/bin`).
  See `sidecar/README.md` for the full control API and packaging story.
- **`ui/` — the manifest (`plugin.json`).** No companion UI of its own; the
  desktop Browser panel is the consumer. `runnables: []`.

## Manifest (`plugin.json`)

- **Sidecar:** `browser` on `:7993`, `command: "ryu-browser"`,
  `command_env: RYU_BROWSER_BIN`, `port_env: RYU_BROWSER_PORT`, `health_path:
  /health`, **`lazy: true`** with `idle_stop_secs: 300`. Declared HTTP routes:
  `/`, `/health`, `/tabs`, `/tabs/:id`, and per-tab `navigate`/`screenshot`/`eval`/`title`.
- **Provides:** capability `browser.control` (v1.0.0) → sidecar `browser`, route
  `/`, grant `browser:control`.
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
Chromium's CDP port (`:9222`) is enabled only when `RYU_BROWSER_CDP=1` (off by
default).

## Swap seam

Any control server that honors the same `/tabs*` loopback contract and bearer
auth can replace the Electron sidecar without touching Core — the `command_env`
override points Core at an alternative binary. The capability, not the process, is
what the desktop panel and agents bind to.
