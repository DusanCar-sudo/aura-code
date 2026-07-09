![Aura](./README-hero.jpg)

<p align="center">
  <img src="assets/ruby-diamond.jpg" width="240" alt="Ruby Diamond Technologies" />
</p>

<h1 align="center">Aura Code — Autonomous Coding Agent</h1>

<p align="center">
  <em>I don't try. I verify.</em>
</p>

---

## What is Aura Code?

Aura Code is an autonomous coding agent built entirely by AI agents. Claude, OpenCode, Pi, Grok, and Aura itself collaborated to design, implement, test, and verify the codebase. The agent that writes your code was itself written by agents. Written in TypeScript — not related to the Ruby programming language.

Built on the **Praktess** framework — from Ancient Greek: *she who acts and executes*.

---

## Quick Start

```bash
npm install -g aura-code
aura 'your task here'
```

Set at least one API key before running:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # Claude
export OPENAI_API_KEY="sk-..."          # GPT
export GOOGLE_API_KEY="..."             # Gemini
export XIAOMI_API_KEY="tp-..."          # MiMo
export ZHIPU_API_KEY="..."              # GLM (Z.ai)
# Local — no API key needed:
# ollama pull qwen2.5-coder:1.5b
```

---

## What She Does

1. **Reads** your codebase — files, structure, dependencies
2. **Plans** a strategy — decides what to change and how
3. **Executes** — writes code, runs commands, makes edits
4. **Verifies** — runs tests, checks file integrity, confirms changes
5. **Reports** — summarizes what was done and what passed

---

### The Memory Loop

Every task feeds forward:

```
TASK → EXECUTE → VERIFY → EPISODE → DREAM → LESSON → next TASK
```

- **EPISODE** — task result recorded automatically in `episodes/*.json`
- **DREAM** — run `:dream` to distill episodes into lessons (`dreams/YYYY-MM-DD.md`)
- **LESSON** — reconciled beliefs injected into every future agent system prompt

See [docs/MEMORY.md](docs/MEMORY.md) and [examples/](examples/) for the full picture.

---

### Context compaction

Long sessions auto-summarize older turns to stay within the model's
context window instead of growing unbounded. This is recently added and
still being hardened against edge cases in unusual tool-call sequences —
if you hit a session that loses track of something it already did, that's
the area to report.

---

## Voice — talk to Aura (`dic`)

Aura ships with **`dic`**, a standalone speech-to-text / text-to-speech tool. Speak a task; it transcribes and types the words straight into whatever window has focus — Aura's prompt, your editor, anywhere.

```bash
dic                 # record → transcribe → type into the focused window (+Enter)
dic --no-inject     # record → transcribe → clipboard only (no typing)
dic toggle          # hotkey mode: 1st run starts recording, 2nd sends
dic loop            # continuous: speak, pause, it types, repeats
dic speak "hello"   # text-to-speech (MiMo TTS)
dic devices         # list microphones
```

**Speech providers** (first available wins): `PARAKEET_BASE_URL` (local NVIDIA Parakeet, no key) › `XIAOMI_API_KEY` (MiMo ASR) › `OPENAI_API_KEY` (Whisper) › `GROQ_API_KEY` (Whisper via Groq).

### Hands-free hotkey (Linux / Wayland)

`dic toggle` is built to sit behind a global shortcut — press once to start talking, press again to send. Typing into the focused window uses, in order, `wtype` → `ydotool` → `xdotool`.

- **KDE / KWin on Wayland** rejects `wtype`, so install **ydotool** and enable its daemon:

  ```bash
  sudo apt install ydotool
  sudo usermod -aG input $USER          # then log out / in
  systemctl --user enable --now ydotool.service
  ```

- **Binding a key** independent of the desktop is most reliable with **keyd**:

  ```bash
  sudo apt install keyd
  # /etc/keyd/default.conf
  #   [meta]
  #   space = command(/path/to/dic-toggle)
  sudo systemctl enable --now keyd
  ```

Now the flow is: **hotkey → speak → hotkey → your words type into Aura's prompt and run.**

---

## Modes

| Mode | What it does |
|------|-------------|
| `normal` | Single-agent loop: read → plan → execute → verify |
| `orchestrate` | Multi-agent: Researcher → Coder → Reviewer |
| `architect` | High-level design and planning before implementation |
| `verify` | Post-task checks with automatic retry on failure |
| `analyze` | Scan session history for failure patterns |

```bash
aura 'fix the bug'                                      # normal
aura --orchestrate 'add error handling to all endpoints' # orchestrate
aura --architect 'design the new auth system'            # architect
aura --verify --test-command "npm test" 'fix the tests'  # verify
aura --analyze                                           # analyze
```

`--doctor` is a sixth, standalone mode: `aura --doctor` scans Aura's own
install (build, config, deps, env, git) across 10 check categories and can
attempt 4 kinds of auto-repair with `--doctor --fix`.

---

## MCP — plug any MCP server into a task

New in 0.9.0: Aura is an **MCP client**. The `mcp` tool (actions:
`connect`, `disconnect`, `list_tools`, `call_tool`, `list_servers`) spawns
an external Model Context Protocol server over stdio and makes its tools
callable mid-task — no integration code, no restart.

What that unlocks in practice: anything in the MCP ecosystem becomes a tool
Aura can reach for while working — GitHub servers, database servers
(Postgres, SQLite), browser automation (Puppeteer/Playwright servers),
Slack, filesystem sandboxes. Aura can decide mid-task "I need a real
browser for this", connect `npx @anthropic-ai/mcp-server-puppeteer`, and
keep going.

**The safety model** (deliberate design, so you understand it rather than
discover it):

- `connect` **requires a y/N confirmation in normal mode**, exactly like a
  non-safe `run_shell` command — the prompt shows the full spawn command
  (`spawn MCP server 'puppeteer': npx @anthropic-ai/mcp-server-puppeteer`).
- Dangerous spawn patterns are **blocked in every mode, including
  `--auto`** — wrapping a destructive command in `mcp connect` cannot
  bypass the `run_shell` screen.
- **Read-only mode blocks `mcp` entirely.**
- **The trust boundary is the connection.** Once a server is approved and
  connected, its tools run via `call_tool` *without further per-call
  prompts* — approve a server the way you'd approve running its binary.
- **The connect-time tool list is an allowlist.** `call_tool` refuses any
  tool the server didn't advertise when you approved it; `tools/list_changed`
  notifications are deliberately ignored, so a server that grows new tools
  post-connect can't have them called until you disconnect and reconnect —
  which re-prompts. (Honest residual gap: this constrains *what Aura will
  ask a server to do*, not what a malicious server can do — a hostile stdio
  server already runs as a local process with your privileges from the
  moment it spawns, tools or no tools. That is why `connect` is the gate.)
  (A live 5-agent [`:ecclesia` review of this design](council/2026-07-09-mcp-server-trust-boundaries-in-ai-coding-agents-is-confirm-a.md)
  concluded connect-time confirmation is the dominant deployed model across
  MCP clients — the protocol defines no per-call authorization — but
  recommends per-call prompts for destructive tools as a hardening step.)

---

## Interactive Commands (REPL)

Run `aura --interactive` (or just `aura` with no task) to drop into the REPL.
`:help` in-session always has the full, current list — this is a snapshot of it.

| Command | What it does |
|---|---|
| `:dream` / `:dream full` | Consolidate recent (or all) episodes into a dated dream entry — see [The Memory Loop](#the-memory-loop). |
| `:rem` | Show the reconciled memory projection, or the latest dream if none exists yet. |
| `:machina <task>` | Run a task with self-verification and automatic retry on failure. |
| `:council <task>` | 2-3 parallel read-only domain specialists, then a synthesis pass. |
| `:ecclesia <topic>` | 5 independent research agents (none sees the others' work) + a synthesis verdict — convergent/contested/minority — saved to `council/*.md\|.html`. `--panel <model>`, `--seats <n>`. |
| `:mine` / `:mine --refine` | Mine `episodes/*.json` for recurring patterns — zero-LLM clustering. `--refine` judges each concept with the local Ruby model and appends training rows to `training-data/*.jsonl`. |
| `:confess` / `:confessions` | Auto-detect and write up an anomalous high-token episode; list past confessions. |
| `:q add / list / run / drop / clear` | Persistent task queue — enqueue prompts, run them later, one at a time. |
| `:btw <question>` | Quick side question, read-only, doesn't pollute the current conversation history. |
| `:research <topic>` | Multi-step research pass, saved to `research/*.md`. |
| `:doctor` / `:doctor --fix` | Same self-diagnostic as `--doctor`, from inside a running session. |
| `/context` | Context health dashboard — token usage bar, compaction ladder, generation count. |
| `/stats`, `/usage` | Token + cost usage for the current session. |
| `:model`, `:provider`, `:apikey` | Switch models, rerun the provider wizard, set an API key mid-session. |
| `:sessions`, `:resume`, `:save` | Session management — list, resume, or rename saved conversations. |
| `:workflow`, `:workflows` | Create/run and list saved multi-step workflows. |
| `:graph`, `:graph refresh` | Codebase knowledge graph summary; re-extract from the current tree. |
| `:viz`, `:dashboard` | Generate and open the memory dashboard. |
| `:approve`, `:approve all/off` | Toggle or set the auto-approve permission level. |

---

## Providers

| Provider | Models |
|----------|--------|
| **Claude** (Anthropic) | Opus, Sonnet, Haiku |
| **GPT** (OpenAI) | gpt-4o, gpt-4o-mini |
| **Gemini** (Google) | gemini-2.5-pro, gemini-2.5-flash |
| **MiMo** (Xiaomi) | mimo-v2.5-pro, mimo-v2.5 |
| **GLM** (Zhipu / Z.ai) | glm-5.2, glm-5.1, glm-5 — `zhipu-coding/<model>` routes via the Coding Plan endpoint |
| **DeepSeek** | deepseek-v4-pro, deepseek-v4-flash (also via OpenRouter) |
| **xAI** (Grok) | grok-2, grok-2-mini, grok-beta |
| **OpenCode Zen** | Gateway to third-party models via `opencode/<model>` or `zen/<model>` |
| **OpenCode Go** | Anthropic-style endpoint via `go-anthropic/<model>` (MiniMax, Qwen) |
| **NVIDIA NIM** | Self-hosted / NIM-served OpenAI-compatible models |
| **Ollama** (Local) | Any local model — no API key needed |

Any OpenAI-compatible endpoint also works via `openrouter/<model>`, or by
registering a custom provider in `.aura.json`.

---

## Known Limitations

- **RubyAlternator** (small-model-first task routing) is implemented and
  tested but not yet routing live tasks — exercising it end-to-end needs
  local inference hardware. It appears on the kanban pipeline view only.
- **Context compaction** — a rare edge case with back-to-back
  assistant-role messages at the compaction boundary is still being
  hardened (see 0.8.0 notes).
- **TUI on very narrow terminals** (< ~60 columns) can crash with a
  layout `RangeError` — resize wider until fixed.
- **MCP `call_tool`** runs without per-call prompts once a server is
  connected, constrained to the connect-time tool allowlist (see the MCP
  safety model above). The allowlist limits what Aura will request, not
  what a malicious local server process can do on its own — connect
  servers you trust.

---

## Stats

| Metric | Value |
|--------|-------|
| Tests | 1331 passing, 0 failures (95 files) |
| Version | v0.9.0 |
| Language | TypeScript (strict) |
| License | MIT |

---

## Repository

GitHub: https://github.com/milodule3-debug/aura-code
(Repo renamed from milodule3-debug/rubyness — existing clone URLs redirect automatically)

---

## Links

- [Lean Progress IQ](https://leanprogressiq.com)
- [Aura Manifesto](her-rubyness-manifesto.html)

---

<p align="center">
  Built by <a href="https://leanprogressiq.com">Lean Progress IQ</a>
</p>
