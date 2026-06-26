# Aura Code — Architecture

> "I don't try. I verify."

## The loop

```
task → system prompt (context + memory + tools) → agent loop → tool calls → verify → respond
```

## Core subsystems

| System | Path | What it does |
|---|---|---|
| Agent loop | `src/agent/loop.ts` | The execution engine. Read → plan → tool → verify → repeat. |
| Context | `src/agent/context.ts` | Builds project awareness: language, framework, tree, config, git history, reconciled memory. |
| Compactor | `src/agent/compactor.ts` | Compresses conversation history when context window fills. |
| System prompt | `src/agent/system-prompt.ts` | Assembles the system prompt from context + memory + design system. |
| Spawner | `src/agent/spawner.ts` | Spins up sub-agents for parallel work. |
| Permissions | `src/safety/permissions.ts` | Three levels: `auto`, `normal`, `read-only`. Controls which tool calls need confirmation. |

## Memory

```
work sessions
  → episodes (src/ruby/episode-capture.ts)
    → :dream (src/dream/dream.ts) — nightly consolidation
      → parser (src/dream/parser.ts) — structured bullets per section
        → reconciler (src/dream/reconcile.ts) — dedup, conflict, strengthen
          → dreams/.reconciled.md — the projection (materialized view)
            → context.ts reads it → system prompt → agent uses memory in next task
```

Dreams are **append-only**. Each day's dream is an immutable record (`dreams/YYYY-MM-DD.md`).

`.reconciled.md` is a **projection** — a materialized view of current beliefs with annotations showing lineage. Old dreams are never modified.

Reconciliation runs after ≥3 dreams exist. Six verdicts:

| Verdict | Meaning |
|---|---|
| KEEP | Unique claim, no overlap, retained. |
| STRENGTHEN | Same claim across multiple dreams. Confidence increases. |
| MERGE | Two related claims combined into one. |
| SUPERSEDE | Newer claim replaces older one. |
| CONFLICT | Two claims contradict. Both surfaced, not resolved. |
| DROP | Exact duplicate removed from projection. |

Confidence is **mechanical**: `sourceDates.length / totalDreams`. Not model-generated.

## Research and Council

| Command | What happens |
|---|---|
| `:research <topic>` | Single agent, multi-turn web research → markdown report in `research/`. |
| `:council <topic>` | 5 independent agents research separately → synthesis reconciles into verdict in `council/`. |
| `:council --reader` | Also generates a narrated HTML reading view (words light up as spoken, emphasis pops in color). |

### Council design

Panel agents are **sequential and independent** — no agent sees another's findings, so agreement is genuine. The synthesis step runs on the user's configured provider (stronger reasoning for reconciliation). Panel model resolution:

1. `--panel <model>` CLI flag (explicit override)
2. `AURA_PANEL_MODEL` env var (global default for cheap runs)
3. User's configured provider model (works for everyone)

## Verification

| System | Purpose |
|---|---|
| `:machina` | Formal model of the codebase. Verifies line-number claims against real source. Catches drift. |
| `council-verify.ts` | Checks panel agents' cited sources against their `toolCallLog`. Flags ungrounded citations. |
| `--verify` flag | Post-task verification with automatic retries (up to `--max-verify-retries`). |

## Provider chain

```
request
  → rate limiter (RPM/TPM)
    → primary model
      → on 429/5xx: exponential backoff + jitter (capped 60s)
        → circuit breaker (trips after 5 consecutive failures)
          → fallback model chain (--fallback)
```

Web search follows a similar fallback pattern:

```
Tavily (API, best snippets)
  → Serper (Google passthrough)
    → DuckDuckGo (HTML scrape, no key)
      → loud error (not silent "no results")
```

## The Ruby Principle

Experimental cost-saving layer. A small/cheap model attempts the task first; only if it fails does the large model run. Episode data tracks which tasks succeed on which tier.

```
task → small model attempt → reviewer checks → if bad → large model → save episode
```

Disabled by default (`:ruby on` to enable).

## Key invariants

1. **Episodes are never burned on provider failure.** The `.last.json` cutoff only advances when consolidation succeeds.
2. **Dreams are append-only.** `.reconciled.md` is a projection, not a replacement.
3. **`:machina` line numbers must match real source.** Insertions that shift lines will break machina tests — and that's by design.
4. **The agent always reads before editing.** Never guesses at file structure.
5. **Search failures are loud.** "No results found" from a broken scraper caused 15-query retry loops. Now all three providers must fail before the error string is returned, and it says "Error:" not "No results."

## Directory layout

```
src/
  agent/          — core loop, context, compactor, spawner, system prompt
  architect/      — blueprint planning (--architect mode)
  cli/            — REPL, display, setup wizard, diamond animation
  config/         — project config (.aura.json), defaults
  dream/          — dream consolidation, parser, reconciliation
  harness/        — weakness mining, proposal generation
  integrations/   — Gmail OAuth, calendar
  kanban/         — kanban board pipeline
  learnlight/     — lesson prep automation
  machina/        — formal self-model, verification
  orchestration/  — multi-agent planning, routing, execution
  perception/     — codebase graph extraction
  providers/      — LLM provider abstraction (OpenAI, Anthropic, Google, DeepSeek, Xiaomi, Ollama, etc.)
  rem/            — dream graph visualization
  research/       — :research and :council commands
  ruby/           — Ruby Principle (small-model-first), episode capture, stats
  safety/         — permission system, safety gates
  server/         — HTTP server mode
  setup/          — first-run wizard, provider wizard
  tools/          — all agent tools (file ops, web search, browser, etc.)
  util/           — env loading, sanitization
  verify/         — post-task verification
  viz/            — dashboard, reader renderer
  workflows/      — multi-step workflow engine
```

## Getting started

```bash
npm install -g aura-code
aura                      # launches setup wizard on first run
aura "fix the auth bug"   # one-shot task
aura                      # interactive REPL
:help                     # see all commands
```

## Stats

- **1205+ tests**, 0 failures
- **v0.6.2**
- TypeScript (strict), MIT license
