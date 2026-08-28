# Aura web client

A graphical client that speaks the same protocol as `aura sidecar`, over the
WebSocket that `aura serve` already runs.

```bash
npm run build          # tsc + the web bundle
aura serve             # open the printed URL (it carries the session token)

npm run dev:web        # Vite dev server on :5273, proxying to serve on :4317
```

## Why React + Vite

The same built assets serve two hosts: `aura serve` today, and a **Tauri** shell
later. Tauri uses the OS webview rather than bundling Chromium, so a desktop
binary is single-digit megabytes instead of Electron's hundred-plus — which is
the "slim desktop, no Electron" requirement, and needs no rewrite of this code.

No CSS framework. The design mirrors the TUI, and every colour is lifted
verbatim from `src/cli/diamond.ts`, so hand-written CSS with custom properties
is both smaller and more faithful than a utility framework would be.

## Architecture

```
web/src/
  lib/protocol.ts    WebSocket peer: promise table + reconnect. No business logic.
  hooks/useAura.ts   All client state: sessions, streaming deltas, tools, approvals.
  components/        Sidebar, Chat, Settings, Markdown, Sigil.
  i18n/              Seven locales; Arabic drives RTL via logical properties.
```

The engine owns conversation truth. This client owns only what the screen needs
between events — which is why `useAura` is the only stateful piece.

## What is wired, and what is not

| Control | Status |
|---|---|
| Streaming, markdown, code copy, stop, regenerate | works |
| Conversation list, open, delete, search | works |
| Tool calls, results, blocked, approval prompts | works |
| Model, max turns, token budget | works |
| **Permission level** | **enforced** — sent as `session.create.permission`, applied by `PermissionSystem` |
| **Sandbox** | **disabled control.** `--sandboxed` is designed (`docs/SANDBOX-DESIGN.md`) but not implemented. A live toggle that changed nothing would manufacture exactly the false confidence that document exists to remove. |
| Skills / plugins list | read-only listing via `/api/skills`, `/api/plugins` |

Skill checkboxes persist locally but the engine does not yet filter on them —
that needs a protocol field, same as permission got.

## Security notes

- Assets are content-hashed and cached hard; `index.html` is `no-store`. Stable
  filenames plus a long max-age meant an upgraded client kept serving the old
  bundle out of cache — observed during development, hence the hashing.
- Auth is the existing pairing token. It arrives in the URL, and the server then
  sets an `httpOnly; SameSite=Strict` cookie so the page's own asset and API
  requests authenticate. Without that every subresource 401s and the page
  renders blank.
- Model output is rendered as markdown with raw HTML disabled and the result
  scrubbed of script/style/event-handler vectors. A chat client that renders
  model output as live HTML is an XSS hole with a nice font.
