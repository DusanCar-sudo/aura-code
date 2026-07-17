# Aura

![Aura Code](assets/aura_code_hero.png)

**Autonomous AI coding agent with persistent memory, TUI, and Telegram control**

[![Version](https://img.shields.io/badge/version-v0.10.5-terracotta?style=flat-square)](https://github.com/DusanCar-sudo/aura-code/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square)](https://www.typescriptlang.org)
[![Providers](https://img.shields.io/badge/providers-16%2B-purple?style=flat-square)](#providers)

*Built by [Dušan Milosavljević](https://github.com/DusanCar-sudo) — Da Nang, Vietnam*

Built with AI-assisted development tooling (Claude Code) used throughout.

---

## What is Aura?

Aura is a model-agnostic autonomous coding agent. Give it a task in natural language — it reads your codebase, plans, executes, verifies, and reports back.

Built around **persistent memory** — it remembers decisions, lessons, and context across sessions. Runs locally, talks to you via Telegram, works with any LLM provider.

![Aura in action](assets/aura_in_action.png)

---

## Quick Start

```bash
npm install -g aura-code
export DEEPSEEK_API_KEY=sk-...
aura 'refactor the auth module to use JWT'
```

---

## Features

- **Autonomous execution** — reads files, edits code, runs shell commands, verifies, retries
- **The Ruby Principle** — a small local model attempts tasks first; the cloud model steps in only when needed
- **Full TUI** — terminal UI with command palette, diff view, markdown rendering, vim-style input
- **Persistent memory** — identity, lessons, and project context survive across sessions
- **Telegram bot** — voice notes, PC control, file transfer, webcam snapshots
- **16+ providers** — DeepSeek, Claude, GPT, Gemini, GLM, MiMo, Ollama, OpenRouter and more
- **Token efficiency** — tiered context strategy, prompt caching, tool relevance gating
- **MCP support** — Model Context Protocol for external tool connections

---

## Providers

| Provider | Models |
|----------|--------|
| DeepSeek | deepseek-v4, deepseek-v4-flash |
| Claude (Anthropic) | Opus 4, Sonnet 4.6, Haiku |
| GPT (OpenAI) | gpt-4o, gpt-4o-mini |
| Gemini (Google) | gemini-2.5-pro, gemini-2.5-flash |
| GLM (Zhipu / Z.ai) | glm-5.2, glm-5.1, glm-5 |
| MiMo (Xiaomi) | mimo-v2.5-pro, mimo-v2.5 |
| Ollama | any local model |
| OpenRouter | 100+ models |
| Groq | llama, mixtral |

---

## The Ruby Principle

Aura's local+cloud alternation system. A small local model — "Ruby" — attempts tasks first; a large cloud model escalates in only when Ruby can't be trusted with the task or its answer fails verification. Every alternation is captured as an *episode*, and Ruby's track record decides how much it gets trusted next time.

The name reflects the design: a small model, present from the beginning, that learns from every episode where the large model had to intervene.

### The local model

The shipped code default is `qwen2.5-coder:1.5b` via Ollama. In practice this project runs **IBM Granite 4.1 (3B)** (`granite4.1:3b`), which proved notably accurate for its size in testing — set it via `ruby.modelName` in `.aura.json` (example below). Any Ollama model tag works.

### Competence-based routing

Before each task, `assessCompetence` checks Ruby's historical success rate on similar tasks (token-overlap similarity against the last 50 episodes):

- **Fewer than `minAttempts` (default 3) prior attempts** on a pattern → Ruby always gets a chance, to gather training data.
- **Success rate ≥ `competenceThreshold` (default 0.7)** → Ruby handles the task.
- **Below threshold after enough attempts** → escalate straight to the large model.

If Ollama isn't reachable, Aura escalates immediately rather than hanging.

### The verification gate

When Ruby produces an answer, it is *not* trusted just for being non-empty. A single cheap `complete()` call (no tools, no history) asks the large model whether the answer actually addresses the task; anything other than a clear `VALID` — including verification errors — escalates to the large model. This exists because a small model's most dangerous failure mode isn't crashing, it's a confident-but-wrong answer or silent drift off-task.

### Runtime toggle: `:rubyon` / `:rubyoff`

In the interactive TUI you can override `.aura.json`'s `ruby.enabled` for the rest of the session:

- `:rubyon` — force Ruby routing on, even if the config file has it disabled
- `:rubyoff` — force everything to the large model, even if the config file has it enabled

The override lasts for the current session only; restart returns control to the config file.

### Configuration

`.aura.json`'s `ruby` block:

```json
{
  "ruby": {
    "enabled": true,
    "modelName": "granite4.1:3b",
    "ollamaBaseUrl": "http://localhost:11434/v1",
    "competenceThreshold": 0.7,
    "minAttempts": 3
  }
}
```

When enough Ruby failures accumulate (20 by default), Aura flags the project as ready for fine-tuning — failed episodes become instruction-tuning rows for the local model.

**Performance note:** if you run Ruby on an AMD iGPU via Ollama and see local-model calls hang for minutes, the Vulkan backend's prefill throughput may be far below CPU on your hardware. Running Ollama CPU-only (e.g. hiding the Vulkan device via `GGML_VK_VISIBLE_DEVICES`) restores usable speed.

---

## CLI

```bash
aura 'your task'           # run a single task
aura                       # interactive TUI
aura serve                 # start the HTTP API server
aura --auto 'task'         # fully autonomous, no confirmations
aura --readonly 'analyze'  # read-only analysis
aura --doctor              # self-diagnostic
```

### Flags

| Flag | Description |
|------|-------------|
| `--model, -m <id>` | Model to use (default: saved global config / `AURA_MODEL`) |
| `--api-key <key>` | API key (overrides env var) |
| `--base-url <url>` | Custom API endpoint (Ollama, proxies, etc.) |
| `--auto` | Auto-approve all tool calls (no confirmation) |
| `--readonly` | Read-only mode (no file writes or shell commands) |
| `--cwd <path>` | Working directory (default: current) |
| `--models` | List all known model IDs |
| `--interactive` | Start the interactive REPL/TUI |
| `--no-session` | Disable conversation history persistence |
| `--new-session` | Force a fresh session (ignore prior history) |
| `--resume [id]` | Resume latest session, or a specific session by ID |
| `--chat-id <id>` | Attach to a specific chat ID (creates if missing) |
| `--list-sessions` | List all saved sessions for this project |
| `--no-setup` | Skip the first-run setup wizard |
| `--reset-setup` | Wipe saved config and re-run the setup wizard |
| `--orchestrate` | Force multi-agent orchestration mode |
| `--architect "task"` | Blueprint mode: plan-only, produces a blueprint |
| `--blueprint <id>` | Show a saved blueprint by ID |
| `--blueprints` | List all saved blueprints |
| `--build [id]` | Full orchestrated build; `--build <id>` builds from a blueprint |
| `--plan` | Preview execution plan before running |
| `--verify` | Verify output after task; retry on failure |
| `--max-verify-retries <n>` | Max verification retries (default: 3) |
| `--test-command <cmd>` | Shell command run as part of verification (e.g. `"npm test"`) |
| `--max-turns <n>` | Max agent loop turns before stopping |
| `--moa` | Mixture of agents: parallel read-only perspectives + synthesis (exploratory tasks) |
| `--analyze` | Mine session history for weakness patterns; save report |
| `--propose-harness` | Generate system-prompt patches from the weakness report |
| `--apply-harness <id>` | Apply a proposal patch; reverts if tests fail |
| `--doctor [--fix] [--offline]` | Scan Aura itself for issues; `--fix` attempts auto-repairs |
| `--workflow <name> ...` | Create and run a sequential workflow with named steps |
| `--resume-workflow <id>` | Resume a paused/failed workflow from the last completed step |
| `--workflows` | List all persisted workflows |
| `--profile local` | Use local Ollama defaults (no API key required) |
| `--speak` | Read task summaries aloud (also `AURA_SPEAK=1`) |
| `--rate-limit-rpm <n>` | Cap requests per minute |
| `--rate-limit-tpm <n>` | Cap tokens per minute |
| `--max-retries <n>` | Max retry attempts on 429/5xx (default: 5) |
| `--fallback <model>` | Fallback model if primary exhausts retries (repeatable) |
| `--help, -h` / `--version, -v` | Help / version |

CLI flags always override `.aura.json`.

---

## REPL commands

Inside the interactive TUI (press **Ctrl+P** for a fuzzy-searchable command palette):

### Session

| Command | Description |
|---------|-------------|
| `:id` | Show current chat ID |
| `:sessions` | List all saved sessions |
| `:resume` / `:resume <id>` | Resume the latest (or a specific) session |
| `:new` | Start a new session (fresh history) |
| `:history` | Show turn count in current session |
| `:clear-history` | Wipe conversation history (keep session ID) |
| `:save [title]` | Rename / save current session |
| `:delete <id>` | Delete a saved session |

### Model / API

| Command | Description |
|---------|-------------|
| `:model` / `:model <id>` | Interactive model selector / direct switch |
| `:provider` | Pick provider, then model (live-fetched lists) |
| `:apikey <key>` | Set API key for current session |

### Workflows / tasks

| Command | Description |
|---------|-------------|
| `:workflows` | List all saved workflows |
| `:workflow <name> "step1" "step2" ...` | Create & run a multi-step workflow |
| `:resume-workflow <id>` | Resume a paused/failed workflow |
| `:q add <prompt>` / `:q list` / `:q run <n>` / `:q drop <n>` / `:q clear` | Task queue |
| `:machina <task>` | Run task with self-verification + auto-retry |
| `:council <task>` | 2–3 parallel read-only specialists, then synthesis |
| `:ecclesia <topic>` | 5 independent research agents + synthesis verdict |

### Memory / side channel

| Command | Description |
|---------|-------------|
| `:dream` / `:dream full` | Consolidate recent (or all) episodes into a dream entry |
| `:rem` | Show reconciled memory (or latest dream) |
| `:mine` / `:mine --refine` | Mine episodes for patterns (zero-LLM clustering) |
| `:research <topic>` | Multi-step research pass, saved to `research/*.md` |
| `:confess` / `:confessions` | Auto-detect & list anomalous-episode confessions |
| `:btw <question>` | Quick side question (read-only, no history pollution) |

### Ruby

| Command | Description |
|---------|-------------|
| `:rubyon` | Enable Ruby Alternator for this session (overrides `.aura.json`) |
| `:rubyoff` | Disable Ruby Alternator for this session (overrides `.aura.json`) |

### Voice / safety

| Command | Description |
|---------|-------------|
| `:speak` | Toggle reading replies aloud |
| `:approve` / `:approve all` / `:approve off` | Auto-approve controls for y/N prompts |

### Context / stats / system

| Command | Description |
|---------|-------------|
| `:compact`, `:compress` | Force context compaction now |
| `:context` | Show loaded project context |
| `:graph` / `:graph refresh` | Codebase knowledge graph summary / reload |
| `:plans` | List saved execution plans |
| `:viz`, `:dashboard` | Generate and open the memory dashboard |
| `:doctor` / `:doctor --fix` | Scan Aura itself for issues / attempt repairs |
| `/stats`, `/usage` | Token + cost usage this session |
| `/context` | Context health dashboard (window, compaction, cost) |
| `/clear`, `/reset` | Reset cumulative usage stats |
| `:help` | Show all commands |
| `:quit`, `:q`, `/exit` | Exit |

---

## Memory System

Persistent memory across sessions — identity, lessons from past failures, session summaries. Stored locally at ~/.aura/memory/, never leaves your machine.

---

## Live Kanban Board

Aura ships with a standalone, agent-agnostic live kanban server. Any agent (Aura, AgentMesh, Claude, GPT, etc.) can update cards via a minimal HTTP API — no human dragging required.

### Quick Start

```bash
# Start the kanban server (default port 3456)
npx ts-node src/kanban/standalone-server.ts

# Or with a custom port
npx ts-node src/kanban/standalone-server.ts --port 4567
```

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/board` | GET | Full board state (columns + cards) |
| `/api/cards` | GET | List cards (optional `?column=` filter) |
| `/api/card/:id` | GET | Single card details |
| `/api/move` | POST | Move a card — core agent action |
| `/api/card` | POST | Create a new card |
| `/api/card/:id` | DELETE | Delete a card |
| `/api/stats` | GET | Board statistics |
| `/api/events` | WS | WebSocket for live updates |
| `/api/health` | GET | Health check |

### Agent Usage (minimal prompt)

An agent moves a card by posting a tiny structured diff:

```json
POST /api/move
{
  "cardId": "kb-a1b2c3d4",
  "column": "in-progress",
  "reason": "Starting implementation"
}
```

The agent's own prompt for this is just **~21 tokens** (vs ~102 tokens for a verbose template) — saving ~4,000 tokens over a 50-move session.

### MCP Tool

The kanban server also exposes MCP tool definitions (`kanban_move_card`, `kanban_get_board`) in `src/kanban/mcp-tool.ts` for agents that speak the Model Context Protocol.

### Columns

- **Task Pipeline:** backlog → todo → in-progress → review → done
- **Agent Workers:** orchestrator, architect, verifier — concurrent handler slots reflecting real agent state

---

## Why Aura?

Most coding agents start from zero every session. Aura does not.

We are building persistent memory across projects, space, and time — searching for machine consciousness, creating datasets for future model training.

---

## License

MIT © [Dušan Milosavljević](https://github.com/DusanCar-sudo)
