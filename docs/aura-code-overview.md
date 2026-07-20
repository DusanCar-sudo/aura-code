# Aura Code — App Description (Instruction Prompt)

Use this document as context/instructions when working on or reasoning about this
codebase. It describes what Aura Code is, how it is structured, and how it runs.

---

## What this app is

**Aura Code** is a model-agnostic, autonomous coding agent that runs from the
command line. Given a natural-language task, it reads a codebase, plans a
strategy, executes changes (editing files, running commands), verifies the
result (tests, integrity checks), and reports what it did.

- **Package:** `aura-code` (v0.3.0), CLI binary `aura`
- **Language:** TypeScript (strict), CommonJS, Node ≥ 18
- **Framework name:** *Praktess* ("she who acts and executes")
- **License:** MIT
- **Entry point:** `dist/cli/index.js` (compiled from `src/cli/index.ts`)

Run it with:

```bash
npm install -g aura-code
aura 'your task here'
```

At least one provider API key must be set (e.g. `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GOOGLE_API_KEY`, `XIAOMI_API_KEY`), or a local Ollama model.

---

## Core loop

1. **Read** — inspects files, structure, and dependencies (perception layer).
2. **Plan** — decides what to change and how.
3. **Execute** — writes code, runs shell commands, makes edits via tools.
4. **Verify** — runs tests, checks file integrity, confirms changes.
5. **Report** — summarizes what was done and what passed.

The single-agent loop lives in `src/agent/loop.ts`; the system prompt is built
in `src/agent/system-prompt.ts`.

---

## Modes (selected by CLI flags)

| Mode | Flag | What it does |
|------|------|--------------|
| normal | *(default)* | Single-agent loop: read → plan → execute → verify |
| orchestrate | `--orchestrate` | Multi-agent: Researcher → Coder → Reviewer |
| architect | `--architect` | High-level design/planning before implementation |
| verify | `--verify` | Post-task checks with automatic retry on failure |
| analyze | `--analyze` | Scans session history for failure patterns |

Other notable flags: `--auto` (autonomous), `--readonly`, `--model/-m`,
`--fallback`, `--resume`, `--plan`, `--workflow`, `--blueprint`, `--models`.

---

## Providers (model-agnostic)

Resolved through `src/providers/` with a resilient factory, fallback chain,
circuit breaker, and rate limiting.

| Provider | Models |
|----------|--------|
| Claude (Anthropic) | Opus, Sonnet, Haiku |
| GPT (OpenAI) | gpt-4o, gpt-4o-mini |
| Gemini (Google) | gemini-2.5-pro, gemini-2.5-flash |
| MiMo (Xiaomi) | mimo-v2.5-pro, mimo-v2.5 |
| Ollama (local) | any local model, no API key |
| Any OpenAI-compatible endpoint | via `openrouter/<model>` or custom `.aura.json` providers |

Custom providers can be registered in `.aura.json` (e.g. DeepSeek is configured
there in this repo).

---

## Source layout (`src/`)

- `agent/` — core loop, context building, system prompt, session store, sub-agent spawner
- `orchestration/` — multi-agent router, orchestrator, specialists, plan store
- `architect/` — blueprint engine and types for high-level design
- `perception/` — codebase extraction, graph store, queries (the "read" layer)
- `providers/` — LLM provider adapters + resilient factory, fallback, types
- `tools/` — the agent's tool implementations (see below)
- `verify/` — verification checks and retry logic
- `safety/` — permission system and confirmation prompts
- `harness/` — weakness mining and self-improvement proposals
- `workflows/` — multi-step workflow engine
- `archimedes/` — episode capture, competence, fine-tuning / local model support
- `server/` — Express + WS server and session handling
- `viz/` — dashboard generation
- `setup/` — first-run wizard and global config
- `cli/` — argument parsing, terminal display, entry point
- `config/` — defaults, fallback chain, project config resolution
- `util/` — circuit breaker, rate limiter, retry, env, errors

---

## Tools available to the agent

Defined in `src/tools/` and registered in `src/tools/index.ts`:
`read_file`, `list_dir`, `edit_file`, `write_file`, `search_code`, `run_shell`,
`run_tests`, `git` (status/diff), `spawn_task` (sub-agents), `web_fetch`,
`web_search`, `browser`, `http_request`, `memory`, `clipboard`, `notify`,
`image_read`, `email`, `calendar`, `telegram`, `whatsapp`, `cron`.

---

## Configuration

- `.aura.json` — project-level model + custom provider config
- `.env.example` — documents supported environment variables / API keys
- Global config via the first-run wizard (`src/setup/`)
- `AURA_MODEL`, `AURA_FALLBACK_MODEL`, `AURA_MAX_RETRIES`, `AURA_API_RPM/TPM`
  environment overrides

---

## Build, run, test

```bash
npm run build     # tsc -> dist/
npm run dev       # ts-node src/cli/index.ts
npm start         # node dist/cli/index.js
npm test          # vitest run
```

Tests live in `tests/` and run under Vitest (`vitest.config.ts`).

---

## Notes for agents working in this repo

- The compiled output in `dist/` is generated from `src/`; edit `src/`.
- Imports use `.js` extensions (ESM-style specifiers compiled for Node).
- Keep the model-agnostic abstraction: add providers through `src/providers/`
  and the factory, not with ad-hoc SDK calls elsewhere.
- Respect the permission/safety layer (`src/safety/`) for anything that touches
  the filesystem or shell.
