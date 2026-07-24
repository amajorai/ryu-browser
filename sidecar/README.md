# @ryu/browser-sidecar

A real-Chromium browser (Electron) Ryu runs as a **`local` manifest sidecar**
(`apps-store/browser/manifest.json`, id `com.ryu.browser`). It exposes a
grant-gated **`browser.control`** capability over a loopback HTTP control server so
Core — and, through Core's ext-proxy, the desktop Browser panel — can drive tabs.

## Control API (loopback, bearer-gated)

Bound to `127.0.0.1`. Every route except `GET /health` requires
`Authorization: Bearer <token>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness (no auth) — `{ok, version, tabs}` |
| `GET` | `/` | Capability root (`browser.control`) info |
| `GET` | `/tabs` | List tabs |
| `POST` | `/tabs` `{url}` | Open a tab |
| `DELETE` | `/tabs/:id` | Close a tab |
| `POST` | `/tabs/:id/navigate` `{url}` | Navigate a tab |
| `POST` | `/tabs/:id/screenshot` | Base64 PNG of the tab (`capturePage`) |
| `POST` | `/tabs/:id/eval` `{expression}` | **PRIVILEGED** — run JS in the tab (`executeJavaScript`) |
| `GET` | `/tabs/:id/title` | Current document title |

## Auth token (fail-closed)

The bearer is resolved as **`RYU_EXT_TOKEN`** (the per-plugin secret Core injects at
spawn and re-stamps on every proxied hop) **else `RYU_BROWSER_TOKEN`** (standalone/dev
override). If **neither** is set the server is **fail-closed** — all protected routes
reject with 401. This mirrors the mail sidecar
(`apps-store/mail/backend/src/main.rs`).

## Port

`RYU_BROWSER_PORT` (Core injects the profile-shifted value via the manifest's
`port_env`) else default `7993`, shifted `+1000` under `RYU_PROFILE=dev`.

## CDP

Chromium's remote-debugging port (`:9222`, loopback) is enabled **only** when
`RYU_BROWSER_CDP=1` (off by default).

## Build / test

```bash
cd apps-store/browser/sidecar
bun install
bun run build   # electron-vite build → out/{main,preload,renderer}
bun test        # control-server routing/auth unit tests (no Electron needed)
```

## Packaging (`ryu-browser` binary)

`electron-builder.yml` packages the built `out/` into a spawnable, version-less
artifact — **`ryu-browser-${os}-${arch}`** (mac `zip`+`dmg`, win `-portable.exe`,
linux `AppImage`) — published to GitHub releases (`amajorai/ryu`), the same feed
`ryu-core` uses. `dist` runs the `electron-vite build` first, so packaging always
operates on a fresh `out/`:

```bash
bun run dist        # build + package for the host platform
bun run dist:mac    # build + package macOS (zip + dmg)
bun run dist:win    # build + package Windows (portable exe)
bun run dist:linux  # build + package Linux (AppImage)
```

The `dist` scripts invoke `electron-builder` via **`bunx`** (fetched on demand, aligned
with island's pinned `^26`) rather than a committed devDependency — packaging is a
manual, release-only step, so this keeps the shared workspace lockfile untouched.
`electron-builder` itself is **not** run in CI (heavy; needs code-signing certs and a
display for some steps) — the `electron-vite build` and the control-server unit tests
are the gates. The config is lint-checked only.

## How Core resolves the binary

Unlike `ryu-mail` (a compiled Rust sibling on `PATH`), this sidecar is an Electron
app, now **packaged** by `electron-builder` into the `ryu-browser` artifact above. The
`com.ryu.browser` manifest declares `command: "ryu-browser"`, which Core resolves as
**`RYU_BROWSER_BIN`** (explicit override) else the bare `ryu-browser` on `PATH` — and
`PATH` includes `~/.ryu/bin`, where Core's managed-companion install drops the
downloaded artifact (mirroring `ryu-core`'s `install.rs`: download to a temp
`.download`, then rename into place).

However the binary is launched, it honors the same runtime contract: it binds
`RYU_BROWSER_PORT` and bearer-authenticates every protected route with
`RYU_EXT_TOKEN` (else `RYU_BROWSER_TOKEN`) — Core injects both at spawn.

For local dev without a packaged binary, point `RYU_BROWSER_BIN` at a launcher that
runs Electron on the built main, e.g. a script wrapping:

```bash
bunx electron apps-store/browser/sidecar/out/main/index.js
```

Runtime launch is **not** verified in CI (Electron needs a display); the build
(`electron-vite build`) and the control-server unit tests are the gates.
