# Aura Code — App Description

Context/instructions for this codebase: what Aura Code is, how it's structured, how it runs.

> **Two docs, two jobs.** This file (`AGENTS.md`, formerly `CLAUDE.md`) describes
> *what the project is*. `AURA.md` holds the standing rules for *how to work in
> it* — project isolation, the three publishing surfaces, branch and secrets.
> Aura loads them into separate system-prompt fields with separate size budgets
> (`ctx.agentNotes` and `ctx.auraRules`, see `src/agent/context.ts`), so don't
> merge them: one shared truncation point would push the standing rules out of
> the prompt. `CLAUDE.md` still resolves as a fallback for un-renamed repos.

---

## What this app is

**Aura Code** = model-agnostic, autonomous coding agent CLI. Natural-language task → read codebase → plan → execute (edit files, run commands) → verify → report.

- **Package:** `aura-code` (v0.9.0), CLI binary `aura`
- **Language:** TypeScript (strict), CommonJS, Node ≥ 18
- **Framework name:** *Praktess* ("she who acts and executes")
- **License:** MIT
- **Entry point:** `dist/cli/index.js` (from `src/cli/index.ts`)

Run:

```bash
npm install -g aura-code
aura 'your task here'
```

Need at least one provider API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `XIAOMI_API_KEY`, `ZHIPU_API_KEY`) or local Ollama model.

---

## Core loop

1. **Read** — inspects files, structure, dependencies (perception layer).
2. **Plan** — decides what to change, how.
3. **Execute** — writes code, runs shell commands, edits via tools.
4. **Verify** — runs tests, checks file integrity, confirms changes.
5. **Report** — summarizes what was done, what passed.

Single-agent loop: `src/agent/loop.ts`. System prompt: `src/agent/system-prompt.ts`.

---

## Modes (CLI flags)

| Mode | Flag | What it does |
|------|------|--------------|
| normal | *(default)* | Single-agent: read → plan → execute → verify |
| orchestrate | `--orchestrate` | Multi-agent: Researcher → Coder → Reviewer |
| architect | `--architect` | Design/planning before implementation |
| verify | `--verify` | Post-task checks, auto-retry on failure |
| analyze | `--analyze` | Scans session history for failure patterns |

Notable flags: `--auto` (autonomous), `--readonly`, `--model/-m`, `--fallback`, `--resume`, `--plan`, `--workflow`, `--blueprint`, `--models`.

---

## Providers (model-agnostic)

Resolved through `src/providers/`: resilient factory, fallback chain, circuit breaker, rate limiting.

| Provider | Models |
|----------|--------|
| Claude (Anthropic) | Opus, Sonnet, Haiku |
| GPT (OpenAI) | gpt-4o, gpt-4o-mini |
| Gemini (Google) | gemini-2.5-pro, gemini-2.5-flash |
| MiMo (Xiaomi) | mimo-v2.5-pro, mimo-v2.5 |
| GLM (Zhipu / Z.ai) | glm-5.2, glm-5.1, glm-5 — general endpoint default, `zhipu-coding/<model>` for Coding Plan |
| Ollama (local) | any local model, no API key |
| Any OpenAI-compatible endpoint | via `openrouter/<model>` or custom `.aura.json` providers |

Custom providers: register in `.aura.json` (e.g. DeepSeek configured here).

---

## Source layout (`src/`)

- `agent/` — core loop, context building, system prompt, session store, sub-agent spawner
- `orchestration/` — multi-agent router, orchestrator, specialists, plan store
- `architect/` — blueprint engine, types for high-level design
- `perception/` — codebase extraction, graph store, queries ("read" layer)
- `providers/` — LLM provider adapters + resilient factory, fallback, types
- `tools/` — agent tool implementations (see below)
- `verify/` — verification checks, retry logic
- `safety/` — permission system, confirmation prompts
- `harness/` — weakness mining, self-improvement proposals
- `workflows/` — multi-step workflow engine
- `archimedes/` — episode capture, competence, fine-tuning / local model support
- `server/` — Express + WS server, session handling
- `viz/` — dashboard generation
- `setup/` — first-run wizard, global config
- `cli/` — argument parsing, terminal display, entry point
- `config/` — defaults, fallback chain, project config resolution
- `util/` — circuit breaker, rate limiter, retry, env, errors

---

## Tools available to the agent

Defined in `src/tools/`, registered in `src/tools/index.ts`:
`read_file`, `list_dir`, `edit_file`, `write_file`, `search_code`, `run_shell`,
`run_tests`, `git` (status/diff), `spawn_task` (sub-agents), `web_fetch`,
`web_search`, `browser`, `http_request`, `memory`, `clipboard`, `notify`,
`image_read`, `email`, `calendar`, `telegram`, `whatsapp`, `cron`, `mcp`
(MCP client — connect/disconnect/list_tools/call_tool/list_servers; `connect`
permission-gated like `run_shell`).

---

## Configuration

- `.aura.json` — project-level model + custom provider config
- `.env.example` — documents supported env vars / API keys
- Global config via first-run wizard (`src/setup/`)
- `AURA_MODEL`, `AURA_FALLBACK_MODEL`, `AURA_MAX_RETRIES`, `AURA_API_RPM/TPM`
  environment overrides

---

## Skills

Two separate sources, injected two different ways:

| Source | Loader | What reaches the prompt |
|--------|--------|-------------------------|
| `.agents/skills/<name>/SKILL.md` (and `.claude/skills/`) — installed by `npx skills add` | `src/plugins/project-skills.ts` | **Catalog only**: name + description + path. The agent `read_file`s a SKILL.md when a task matches. |
| `~/.aura/plugins/<name>/skills/<name>/SKILL.md` — installed plugins | `src/plugins/loader.ts` | Full bodies, gated on a web-keyword regex in `system-prompt.ts`. |

The split is about scale: a `skills add` catalog runs to hundreds of KB of
bodies, so pasting them is impossible and routing has to be the model's
decision against a list of descriptions. Plugin skills are a handful of KB and
predate this.

`:skills` in the REPL prints the parsed catalog — if a skill is not in that
list, the agent cannot see it (a skill with no frontmatter `description:` is
dropped as unroutable, and still passes `aura doctor`).

---

## Build, run, test

```bash
npm run build     # tsc -> dist/
npm run dev       # ts-node src/cli/index.ts
npm start         # node dist/cli/index.js
npm test          # vitest run
```

Tests in `tests/`, run under Vitest (`vitest.config.ts`).

---

## Notes for agents in this repo

- `dist/` compiled from `src/` — edit `src/`.
- Imports use `.js` extensions (ESM-style specifiers compiled for Node).
- Keep model-agnostic abstraction: add providers through `src/providers/`
  and factory, not ad-hoc SDK calls elsewhere.
- Respect permission/safety layer (`src/safety/`) for filesystem/shell ops.