# aura-mathetes as a thin protocol client — audit

**Status:** audit only. No port started, as asked.

## Read this first: the source is gone

`/home/dusan/aura-mathetes` contains **no source code**. The directory skeleton
survived; every file did not.

| Check | Result |
|---|---|
| Files anywhere in the tree | **13** — 4 Python venv binaries, 9 dangling `node_modules/.bin` symlinks |
| `*.rs` files | 0 |
| `*.ts` / `*.tsx` files | 0 |
| `package.json`, `Cargo.toml` | absent |
| `src/`, `src-tauri/src/agent`, `src-tauri/src/llm` | present, **empty** |
| `.git/` | present but gutted — no `HEAD`, no `config`, no `index`; `objects/` shard dirs exist and hold **0 files** |

The pattern — directories preserved, every regular file removed, symlinks left
dangling — is the signature of a partial restore or an interrupted sync, not a
normal delete. **`.git` is empty too, so there is nothing to `git checkout`.**

This is data loss worth attending to independently of any port.

### What this audit was reconstructed from

Not from source. From Aura's own session transcripts of past work on the
project, at
`/mnt/bigpool/moved-from-system/home-dusan/.aura/sessions/_home_dusan_aura-mathetes/`
(three sessions, ~985 KB, carrying 54 `#[tauri::command]` occurrences plus
`generate_handler![]` registration lists).

**Treat every command name below as evidence, not as ground truth.** The list may
be incomplete, and it is certainly as stale as the transcripts. It is good enough
to size the work and to answer the question actually asked — *is this
mechanical?* — and not good enough to port against.

### Possible recovery routes, in order of promise

1. **A git remote.** `.git/config` is gone, so the remote is unknown from here.
   If the project was ever pushed, cloning is the whole answer.
2. **The session transcripts.** They contain substantial verbatim source — full
   functions, structs, `Cargo.toml` excerpts. Tedious, partial, but real.
   Caution: these transcripts are known to carry live secrets, so treat the
   files as sensitive and rotate anything found.
3. **`~/.local/share/app.auramathetes.client`** — 533 files, almost all WebKit
   cache blobs including several identical ~1 MB resources, likely the cached
   frontend bundle. That could recover *built* frontend JS, never Rust source.

## The question asked

> Method shapes were deliberately mirrored to the existing Tauri command
> surface, so this should be mechanical.

**That is true for 5 commands and false for roughly 31.** The mirroring is real
but partial, and the unmirrored remainder is where all the work is.

## The protocol surface that exists

`src/protocol/` — 790 lines, complete and tested (25 tests in
`tests/protocol/handler.test.ts`).

Requests: `session.create`, `session.destroy`, `session.list`,
`session.history`, `session.state`, `turn.send`, `turn.cancel`, `tools.list`,
`usage.get`. Reverse-call: `approval.request`. Events: `engine.ready`,
`turn.started`, `turn.delta`, `turn.tool_call`, `turn.tool_result`,
`turn.tool_blocked`, `turn.completed`, `turn.error`, `log`.

## Command-by-command

### Group 1 — mechanical (5 commands, ~1 day total)

Exactly the mapping `src/protocol/types.ts:65` documents.

| Tauri command | Protocol method | Estimate |
|---|---|---|
| `create_agent` | `session.create` | 2h |
| `run_agent` | `turn.send` + event stream | 4h |
| `get_agent_messages` | `session.history` | 2h |
| `list_tools` | `tools.list` | 1h |
| `get_workspace_state` | `session.state` | 2h |

`run_agent` is the largest because the Tauri version returns once whereas
`turn.send` streams `turn.delta` / `turn.tool_call` / `turn.completed`. The
client's rendering changes shape even though the call does not.

### Group 2 — NOT mechanical: no protocol counterpart exists

Each of these needs a protocol design decision before any code.

| Group | Commands | Flag |
|---|---|---|
| **PTY / terminal** | `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`, `open_terminal` | 🚩 **Hardest.** Needs a bidirectional byte-stream channel the protocol does not have — it is request/response plus one-way events. A PTY is neither. Either add a duplex channel or leave the terminal client-local and out of the engine entirely. **Design first: 1–2 days. Implementation: 3–5 days.** |
| **Local model lifecycle** | `llama_discover`, `llama_start`, `llama_status`, `llama_stop` | 🚩 aura-code discovers local backends (`src/archimedes/endpoint.ts`, `resolve-config.ts`) but never **starts or stops** one. Real new engine capability, not a binding. **3–4 days**, and a decision about whether the engine should own process lifecycle at all. |
| **Host process control** | `system_stats`, `system_kill_process`, `system_limit_cpu`, `system_remove_limit` | 🚩 Killing processes and setting CPU limits on the host, over a protocol, is a **security decision, not a port task**. Adding it hands any protocol client the ability to kill arbitrary processes. Recommend: do not port. If it must exist, it belongs behind the sandbox work (`docs/SANDBOX-DESIGN.md`), not before it. **Decision, not an estimate.** |
| **Mesh / multi-model** | `mesh_debate`, `mesh_ensemble`, `mesh_review` | aura-code has the machinery (`src/orchestration/`, `src/research/council.ts`) but exposes none of it over the protocol. Mostly plumbing once the method shapes are agreed. **2–3 days.** |
| **Memory** | `memory_get_context`, `memory_store_message`, `memory_stats`, `memory_create_peer` | Backed by `src/agent/unified-memory.ts`. `memory_create_peer` implies a peer/sync model with no analogue in aura-code — 🚩 flag that one specifically. **2 days + 1 unknown.** |
| **Plugins** | `plugin_fetch_registry`, `plugin_install`, `plugin_list_installed`, `plugin_uninstall` | 🚩 `src/plugins/hooks.ts` states plainly that hooks are user-installed code running **unsandboxed** with full privileges. Installing plugins *over a protocol* widens that considerably. Same recommendation as host process control: after the sandbox, not before. **2 days + security review.** |
| **Skills** | `list_skills`, `read_skill` | Straightforward read-only additions. **1 day.** |
| **File / tool access** | `read_file`, `write_file`, `read_dir`, `execute_tool` | 🚩 Conceptually redundant — in a thin-client model the **engine** runs tools, so a client calling `write_file` directly bypasses the permission system and the path jail. If the UI needs a file browser, that wants a *narrow, read-only* method, not a port of these four. **Design decision, ~1 day once decided.** |

### Group 3 — protocol features with no Tauri counterpart

The client must **gain** these; they are not ports:

- `approval.request` — the engine asking the client to confirm a tool. The Tauri
  surface has nothing like it. Genuinely new UI. 🚩 **2–3 days.**
- `turn.cancel`, `session.destroy`, `session.list`, `usage.get` — small, ~half a
  day each.
- The seven `turn.*` events — the rendering-model change noted above.

## Totals

| Bucket | Estimate |
|---|---|
| Mechanical (group 1) | ~1 day |
| Straightforward but new (skills, mesh, memory, small protocol gaps) | ~7–9 days |
| Flagged, needs a decision before estimating (PTY, llama lifecycle, plugins, host control, file access) | ~10–15 days **plus** 2 security decisions |
| **Realistic total** | **3–5 weeks**, not a mechanical afternoon |

## Recommendation

1. **Recover the source first.** Everything below is unbuildable until then, and
   these estimates rest on transcript evidence rather than the real tree.
2. **Do not port `system_*` or `plugin_*`.** Both widen the attack surface across
   a protocol boundary; both should wait behind `--sandboxed`.
3. **Decide the PTY question early** — duplex channel in the protocol, or
   terminal stays client-local. It is the single largest fork in the plan.
4. Group 1 genuinely is mechanical. It is also about 3% of the work.
