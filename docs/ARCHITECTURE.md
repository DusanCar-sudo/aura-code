# Aura Code — Architecture

> "I don't try. I verify."

## The Abstract Agent Machine

Aura is not "an LLM with a loop around it." It is formally modelled as a **5-tuple Abstract Agent Machine (AAM)**:

```
AAM = (S, P, O, δ, s₀)
```

| Component | Meaning | What it is in Aura |
|---|---|---|
| **S** | State space | Conversation history plus loop counters. Every run lives inside S. |
| **P** | Primitives | The finite, enumerable set of tool calls the machine can invoke — 27 tools across `src/tools/*.ts`. |
| **O** | Oracle | The only swappable part — an LLM, a human, a rule table, or another AAM run recursively. |
| **δ** | Transition function | δ(s, O(s)) → s′: consult the oracle, run its output through the safety gate, execute tool calls against P, fold results into history. |
| **s₀** | Initial state | Empty history plus the user's task as the first message. |

This formal model is what makes Aura **provider-agnostic by construction, not by convention**. Swap the oracle (Claude → GPT → Gemini → MiMo → local Ollama) and the machine is unchanged — S, P, δ, and s₀ remain identical. This isn't a design goal stated in prose; it's a structural property of the system.

Verified against live source via `:machina` (see `docs/machina.html` for the full grounding table and diagram).

## The Agent Loop — δ in practice

The agent loop (`src/agent/loop.ts`) is the concrete implementation of δ. Each iteration:

1. **Compaction check** — before consulting the oracle, the loop measures current history size against the model's context window and compares it to an escalating **generational ladder**: `LADDER = [0.55, 0.70, 0.85]` (`src/agent/compactor.ts:13`). Each time a recap gets recompacted the threshold for the *next* pass rises one rung; once it crosses the ladder for the current generation, `compactHistory()` runs (checked at `src/agent/compactor.ts:227`, triggered from `src/agent/loop.ts:217`).

2. **Oracle invocation** — `provider.stream(system, history, TOOL_DEFINITIONS)` at `src/agent/loop.ts:235`. Yields text chunks, tool start/input/end events, and a final `{ stopReason }`.

3. **Safety gate** — every tool call from the oracle is checked against the permissions system before execution (`src/agent/loop.ts:349`). Dangerous invocations may require user confirmation.

4. **State update** — tool results and oracle text fold back into S.

5. **Loop back** — s′ becomes the new s. Continues until the oracle signals `stopReason: 'done'` or the turn counter hits the bound.

**The halting bound:** `maxTurns: 150` by default (`src/config/defaults.ts:10`), sized per task shape by the loop's profile logic. A run that hits its ceiling while still making visible progress gets **one** upgrade to a wider ceiling instead of dying with a resume hint — `--max-turns` set explicitly on the command line never widens. This makes the *real* machine decidable — it always terminates — unlike the unbounded theoretical AAM, which is Turing-complete and therefore subject to the Halting Problem: no general test can say whether an arbitrary unbounded task ever finishes. Real Aura is deliberately not that machine.

### Context compaction, precisely

`src/agent/compactor.ts` does not simply keep "the last N messages." The real rule, in order:

1. Walk backward from the end of history accumulating message token-cost until the verbatim tail would exceed `RETENTION_RATIO` (40%) of the model's context window — this sets the initial `keepFrom` boundary by *budget*, not by a fixed message count.
2. Snap that boundary forward to the nearest user-turn start within the next 6 messages, if one exists, so the kept slice opens with real user context and no `tool_use`/`tool_result` pair gets split.
3. **Only if no user turn is found** nearby does it fall back to a fixed window: `FALLBACK_KEEP = 3` — the 3 most recent messages — then walked forward past any leading `tool_result` so the kept slice never opens on an orphaned result.

So "keep the 3 most recent messages" is the *fallback* path, not the primary rule. The primary rule is token-budget-aware and turn-boundary-aware: don't cut a user's question away from its context, whenever a reasonable cut point exists within budget.

### Tool primitives (P)

27 tools, defined across `src/tools/*.ts` — 9 inline in `index.ts` (`read_file`, `list_dir`, `edit_file`, `write_file`, `search_code`, `run_shell`, `run_tests`, `git_status`, `git_diff`) plus the remainder as standalone definitions in their own files (`web_search`, `web_fetch`, `browser`, `memory`, `clipboard`, `notify`, `image_read`, `email`, `calendar`, `cron`, `audio_transcribe`, `youtube_transcript`, `mcp`, `telegram`, `whatsapp`, `gmail`, and others). Finite and enumerable — that's what makes P a real component of the tuple, not just "a big toolbox."

## Memory, Dreams, and Reconciliation

Aura does not have a traditional database. It has an **event-sourced, offline consolidation pipeline**, modelled on biological sleep.

```
episodes (raw experience, append-only)
  → :dream (src/dream/dream.ts) — nightly/on-demand consolidation
    → parser (src/dream/parser.ts) — structured bullets per section
      → reconciler (src/dream/reconcile.ts) — dedup, conflict, strengthen
        → dreams/.reconciled.md — the projection (materialized view)
          → knowledge/ — portable OKF v0.1 bundle (src/dream/okf.ts)
            → context.ts reads it → system prompt → agent uses memory
```

### Dreams

A dream is an offline consolidation pass over recorded episodes:

1. **Recall** — load episodes since the last dream (cutoff tracked in `dreams/.state.json`, and only ever advanced after a dream is successfully written — see the key invariant below).
2. **Consolidate** — feed episode digests to an LLM, distilling them into `## Lessons`, `## Patterns`, `## Open threads`, and a `## Tomorrow brief`.
3. **Prepare** — write one dated `.md` file under `dreams/<date>.md`.
4. **Reconcile** — if ≥3 dreams exist, run cross-dream reconciliation.
5. **OKF bundle** — if reconciliation succeeds, write a portable knowledge bundle to `knowledge/`.

Key invariant: the cutoff timestamp only advances when consolidation succeeds. If the provider fails, episodes are preserved, never burned. A single Ollama fallback is tried before giving up. Reconciliation itself is best-effort — if it fails, the dream file is already safely written.

### Reconciliation

Produces `dreams/.reconciled.md` — the agent's current best understanding, with lineage annotations. Six verdicts:

| Verdict | Meaning |
|---|---|
| KEEP | Unique claim, no conflict — retained as-is. |
| STRENGTHEN | Same claim across multiple dreams — confidence up. |
| MERGE | Related claims combined into one. |
| SUPERSEDE | Newer claim replaces an older one. |
| CONFLICT | Contradictory claims — both surfaced, never silently resolved. |
| DROP | Exact duplicate or obsolete — removed. |

Confidence is **mechanical, not model-generated**: `confidence = sourceDates.length / totalDreams`. A model-generated "0.72" is theater; "appears in 8 of 14 dreams → 0.57" is data.

**3-dream gate** — reconciliation only runs when ≥3 dreams exist; below that there isn't enough history for meaningful cross-dream analysis. The reconciliation prompt explicitly instructs the LLM: *"Do NOT invent new claims. Only work with what's in the input."*

### OKF Bundle

Reconciled beliefs are also written as an Open Knowledge Format v0.1 bundle to `knowledge/` — `index.md`, `log.md`, and per-section subdirectories (`lessons/`, `patterns/`, `open-threads/`), each concept as its own `.md` file. Regenerated every reconciliation pass; a projection, not a durable store. Old dream files remain untouched as an append-only audit trail.

### Injection into the agent loop

Reconciled memory is loaded in `context.ts` (`loadReconciledMemory`), which reads `dreams/.reconciled.md`, strips YAML frontmatter, truncates to ~2000 characters, and injects it into the system prompt under `### Memory (from past sessions)`. Optional — if no reconciled file exists, the prompt is identical to a memoryless agent.

## Experience Mining — Baby Ruby & Papa Ruby

A second, independent path from raw episodes to usable knowledge — pure statistics first, local-model judgment second.

```
episodes
  → Baby Ruby (src/mining/extract.ts) — NO LLM, pure clustering/statistics
    → concepts (MinedConcept[])
      → Papa Ruby (src/mining/refine.ts) — local LLM judgment
        → training-data/*.jsonl — fine-tuning-ready output
```

**Baby Ruby** clusters episodes by category, then recursively splits by keyword overlap (depth-bounded at 3, size-bounded at 3 episodes minimum — a real termination condition, not unbounded recursion). Zero LLM calls, zero API keys, zero network. Confidence is mechanical: cluster size relative to total episodes.

**Papa Ruby** takes Baby Ruby's concepts and asks a local model (RubyAlternator's configured small model, e.g. `qwen2.5-coder:1.5b` via Ollama) to judge whether each concept is a real, generalizable lesson or coincidental noise. Pre-call gating skips weak-signal concepts before ever spending a model call. Deduplicates against `dreams/.reconciled.md` so the two independent pipelines (dream reconciliation and mining) don't produce redundant rows. Accepted lessons are written as `TrainingExample` rows, ready for external fine-tuning — the same approach used to build the Serbian Legal LLM corpus.

Implemented in `src/mining/extract.ts` and `src/mining/refine.ts`; as of this
writing there is no `:mine` REPL command or CLI flag wired to either stage —
the pipeline runs, but only when called directly (e.g. from tests or another
module), not from user-facing Aura.

## Council and Research

| Command | What happens |
|---|---|
| `:research <topic>` | Single agent, multi-turn web research → markdown report in `research/`. |
| `:council <topic>` | 2-3 parallel read-only domain specialists (Mixture of Agents, `src/agent/mixture.ts`), never seeing each other's work, then one synthesis pass. |

`src/research/council.ts` also implements a separate, independently-testable
5-agent Ecclesia (`runCouncil`, default `panelSize: 5`, resolves its panel
model from the configured provider or a `--panel`/`AURA_PANEL_MODEL`
override) described in `docs/COMMITTEE.md` — as of this writing it is not
called from the CLI or REPL, so `:council` currently means the 2-3-agent
Mixture of Agents path above, not this Ecclesia.

## Verification

| System | Purpose |
|---|---|
| `:machina` | The formal AAM model itself, verified line-by-line against live source. Catches drift when code changes shift line numbers. |
| `council-verify.ts` | Checks panel agents' cited sources against their own tool-call logs. |
| `--verify` flag | Post-task verification with automatic retries. |

## Provider chain

```
request → rate limiter → primary model
  → on 429/5xx: exponential backoff + jitter (capped 60s)
    → circuit breaker (trips after 5 consecutive failures)
      → fallback model chain (--fallback)
```

Web search follows the same resilience pattern: Tavily (API) → Serper (Google passthrough) → DuckDuckGo (HTML scrape, no key) → a loud, explicit error if all three fail — never a silent "no results."

## Key invariants

1. Episodes are never burned on provider failure — the dream cutoff only advances on success.
2. Dreams are append-only; `.reconciled.md` and `knowledge/` are projections, regenerable from the underlying dreams.
3. `:machina`'s claims must match real source — drift is caught and fixed, not papered over.
4. The agent always reads before editing; never guesses at file structure.
5. Search and other tool failures are loud, never silently swallowed into a false "no results."
6. The unbounded theoretical machine is Turing-complete and undecidable; the real machine trades some of that theoretical power for guaranteed termination via `maxTurns` and context compaction.

## Stats

- **1317 tests**, 0 failures (94 files)
- **27 tool primitives**
- **v0.8.0**
- TypeScript (strict), MIT license
