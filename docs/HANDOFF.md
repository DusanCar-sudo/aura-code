# Handoff — web client, and the road to TUI parity

Written for a fresh context. Read this before touching `web/` or `src/cli/`.

---

## The goal, in the owner's words

> "I want it to be as functional as the TUI — not really a replacement, but two
> surfaces with the same capabilities, so users can choose desktop, web, or TUI."

Parity, not replacement. Both surfaces stay first-class. **Work proceeds one
group at a time**, suite green at every step.

---

## Where things stand

Branch `feat/web-client`, 16 commits ahead of `master`. The last four are the
web client; the twelve before are an unrelated repair plan (provider registry,
Archimedes verifier, benchmarks) that happened in the same session.

Suite: **2410 passed / 9 skipped**. That is the floor — do not merge below it.

```bash
npm run build          # tsc + vite (dist/ and dist/web/)
npm test               # vitest
aura serve             # open the printed URL; it carries the session token
npm run dev:web        # Vite on :5273, proxying to serve on :4317
```

### Unmerged branches worth knowing about

`refactor/repl-commands-and-skills` — **read this before starting parity work.**
It already extracts three more command groups out of `cli/index.ts`
(`repl-archimedes-commands.ts`, `repl-skills-command.ts`,
`repl-usage-commands.ts`) using exactly the pattern parity needs. Either merge it
first or rebase onto it; duplicating that extraction would be waste.

---

## The web client

`web/` → builds to `dist/web/`, served by `aura serve`. React + Vite, no CSS
framework. The same build is intended to become a **Tauri** frontend later
(OS webview, single-digit MB, no Electron), so nothing may assume a browser-only
environment.

```
web/src/
  lib/protocol.ts    WebSocket peer: promise table + reconnect. No business logic.
  lib/commands.ts    ':' command dispatch — see "Commands" below.
  lib/settings.ts    Per-browser preferences.
  hooks/useAura.ts   All client state: sessions, streaming, tools, approvals.
  components/        Sidebar, Chat, Composer, Settings, Markdown, Sigil.
  i18n/              7 locales; Arabic drives RTL via logical properties.
  assets/            archangel.png — the watermark.
```

The engine half already existed: `aura serve` runs a `ProtocolHandler` over its
WebSocket with the same frame schema as `aura sidecar`. **The client is a view.
The engine owns conversation truth.**

### Design constraints that are not negotiable

- Colours come from `src/cli/diamond.ts`, verbatim. The TUI is the reference.
- Type scale lives in three variables (`--fs-body: 14px`, `--fs-small: 12.5px`,
  `--fs-micro: 11px`). Changed twice already on owner feedback — 11/12px read
  badly on screen. Change the variables, not individual rules.
- The chat column is centred **on the viewport**, not in the space beside the
  sidebar. `padding-inline-end: var(--sidebar-w)` does it exactly: main starts at
  S and is (V−S) wide, so the centre is S + (V−S−P)/2, which equals V/2 when
  P = S. Only while the sidebar is docked.
- Watermark: Archangel Michael at 10%, with its glow. The owner reviewed a
  glow-stripped version and preferred the original. Do not "clean it up".
  Dark theme lifts it (`brightness(1.7)`) or it vanishes against `#0f1724`.

### Three engine bugs the client surfaced

Kept here because each will bite again if reintroduced:

1. **Assets 401'd, page rendered blank.** Auth accepted only `?token=` or a
   header, and a browser attaches neither to a `<script>` it was told to fetch.
   A proven token is now promoted to an `httpOnly; SameSite=Strict` cookie.
2. **Stale bundle after every rebuild** — stable filenames plus a 1h max-age.
   Assets are content-hashed now; `index.html` is `no-store`.
3. **`session.create` hardcoded `PermissionSystem('normal')`.** A client showing
   a permission control could not change enforcement.

---

## Commands — the actual state

`web/src/lib/commands.ts`. Anything starting with `:` is intercepted **before**
it can reach the model. This was a real bug: the `/` menu pasted the command
into the composer, which sent it as an ordinary turn, so `:resume` made the
agent research the word "resume".

- **14 run in the client**: `:new :resume :sessions :history :id :save :context
  :usage :model :provider :apikey :approve :help :q`
- **23 are terminal-only**, listed in `TERMINAL_ONLY` and reported by name as
  such. They are not swallowed and never sent as a prompt.
- The `/` menu is served from `GET /api/commands` → `PALETTE_COMMANDS`
  (41 entries), so the two surfaces cannot drift.

### Why the other 23 are hard

They are dispatched inline in `src/cli/index.ts` (168 KB) against REPL objects
the protocol never exposes: display, session store, budget, steering inbox.

**The load-bearing fact**, from `repl-usage-commands.ts`'s own header:

> `cli/index.ts` self-executes on import (it reads real credentials into
> `process.env` at module scope), so a branch that lives there cannot be covered
> by a test.

So extraction is not tidying — it is the only way those commands become
testable *or* reachable from anywhere but the terminal.

---

## The parity plan

### Step 1 — extract command groups into shared modules

Follow the established pattern. Six already exist
(`repl-{computer,cost,lesson,mode,session,turn}-commands.ts`) and the unmerged
refactor branch adds three more. Each module exports a handler taking an
**explicit context object**, returning a result or `null` when it does not own
the input.

Do one group per commit, with tests, suite green each time. Suggested order —
highest value first, and each is independently useful even if parity stalls:

| Group | Commands | Notes |
|---|---|---|
| Memory | `:dream :rem :mine :lessons :forget :research :btw` | Most-asked; `repl-lesson-commands.ts` already covers part |
| Safety | `:compon :compoff :comp :approve` | `repl-computer-commands.ts` exists — mostly wiring |
| Archimedes | `:archon :archoff :archmodel` | Already extracted on the refactor branch |
| Workflows | `:workflow :workflows :machina :council :q add/list` | Longest-running; needs streaming |
| System | `:doctor :compact :compress :turnson :turnsoff :speak` | Small, do last |

### Step 2 — a `command.run` protocol method

Once a group is extracted, expose it:

- `command.run` → `{ sessionId, input }`, engine executes, streams output as
  events (reuse `turn.delta` / a new `command.output`).
- Long-runners (`:dream`, `:council`) must stream and be cancellable, so they
  belong on the same turn machinery, not a request/response call.
- Move the command from `TERMINAL_ONLY` to `LOCAL_COMMANDS` **only** once it
  genuinely runs. Never pre-emptively.

### Step 3 — per-command UI where text is not enough

`:model` and `:provider` are pickers (the Provider tab already is one);
`:context` is a dashboard; `:lessons` is a timeline. Plain monospace output is
the fallback, already implemented as the `system` message role.

---

## Deliberate limitations — do not "fix" by faking

- **Sandbox toggle is disabled.** `--sandboxed` is designed
  (`docs/SANDBOX-DESIGN.md`) but not implemented. A live toggle that changed
  nothing would manufacture the false confidence that document exists to
  remove. bubblewrap is verified working on this machine; implementing it is a
  real task, not a UI change.
- **Tool toggles trim what the model is offered — they are not security.**
  Blocking execution is the permission level's job. The UI says so.
- **Skill checkboxes persist locally but the engine does not filter on them.**
  Needs a protocol field, exactly as `permission` and `allowedTools` got one.
- **API keys are process-scoped.** `POST /api/apikey` sets `process.env` for the
  running engine only; never written to disk, forgotten on stop. It accepts only
  key names `PROVIDER_REGISTRY` declares, so it cannot become "set any env var".
  `GET /api/providers` answers *whether* a key is set, never its value.

---

## Verification habits that caught real bugs

- **Drive the real UI**, but note the owner may be clicking in the same browser
  — state changing under you is probably them, not a bug. Confirm with
  `localStorage.getItem('aura.settings')` before chasing it.
- **Prove engine wiring over the socket**, not through the UI. A short
  `ws` script that does `session.create` → `turn.send` and prints events
  verified both `allowedTools` and the streaming path. The UI can pass for the
  wrong reason.
- **Vendor SDKs capture `fetch` at import**, so stubbing `globalThis.fetch` does
  not reach them — a "replay" test written that way silently makes real network
  calls and passes. Replay through the parsers instead
  (`tests/providers/wire-fixtures.test.ts`).
- Live benchmarks are excluded from `npm test` by design; opt in with
  `AURA_LIVE_BENCH=1`. A benchmark that self-skips is indistinguishable from one
  that passes — that is why `AURA_ESCALATION_VERIFIER_MODEL` exists.

---

## Open questions for the owner

1. **GitHub URL in About** is a guess (`github.com/leanprogressiq`) — needs the
   real one.
2. **Marketplace management** — bare plugin names need a registered marketplace.
   Add/remove marketplace UI to the Skills tab?
3. **Which command group first** — Memory or Safety.
4. **`:sandboxed`** — implement now (bubblewrap is proven) or after parity?

---

## Environment notes

- Working dir `/mnt/bigdata/aura/aura-code`. `which aura` resolves to this
  repo's `dist/cli/index.js`, so a dev checkout **is** the install — relevant to
  the sandbox design, which cannot hold both guarantees there.
- Keys present: `GOOGLE_API_KEY`, `ZHIPU_API_KEY`, `DEEPSEEK_API_KEY`
  (**DeepSeek and Zhipu are out of balance** — use `gemini/gemini-3.6-flash`).
  No `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
- Ollama is up; LM Studio is not.
- `aura-mathetes` is **gone** — 13 files remain in the whole tree (venv binaries
  and dangling symlinks), `.git` gutted. See `docs/MATHETES-PORT-AUDIT.md`.
- RTK rewrites shell commands and filters output; `ls`/`find` can under-report.
  Use `python3 -c "import os; ..."` for ground truth about the filesystem.
