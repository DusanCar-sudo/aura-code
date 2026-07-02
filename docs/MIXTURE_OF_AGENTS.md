# Mixture of Agents — Phase 1: Domain Expertise

`src/agent/domain-expertise.ts` + one added param on `buildSystemPrompt`

## Problem

Aura had one system prompt for every task — generic coding-agent instructions,
no matter whether the task was a CSS layout fix, a database migration, or an
auth endpoint. Real expertise (accessibility checks for frontend, transaction
safety for database work, injection risks for security-touching code) never
made it into the model's attention unless it happened to already know to
apply it.

## What it does (Phase 1 — live)

**Domain classification** (`classifyDomains`) — same cheap-keyword philosophy
as the loop classifier. Scores 7 domains by keyword hits in the task string,
returns the top 2 matches (capped, to keep the prompt lean), empty array if
nothing matches:

`frontend`, `backend`, `database`, `security`, `devops`, `testing`, `algorithms`

**Prompt injection** (`getDomainPromptBlock`) — for each matched domain,
appends a concrete, imperative checklist (4 bullets, same terse style as the
rest of `system-prompt.ts` — no fluff, no "consider whether..."). Example,
`security`:

```
- Never log secrets, tokens, or passwords, even at debug level.
- Parameterize all queries — string-concatenated SQL is an injection
  vector regardless of "trusted" input.
- Check auth/permission boundaries on every new endpoint or route, not
  just the ones the task explicitly mentions.
- Treat any credential found in code, commits, or chat as compromised —
  flag it once, recommend rotation, don't just fix the immediate leak.
```

`buildSystemPrompt` now takes `task` as a third argument specifically to
feed this classifier. Every call site was updated (`loop.ts`); `spawner.ts`
imports `buildSystemPrompt` but doesn't call it directly (goes through
`runAgentLoop`), so it needed no change.

## Why this shape (not a separate agent, not an extra LLM call)

Mixture-of-agents in the literature usually means multiple models each
propose an answer, then something aggregates. That's real but expensive —
N model calls instead of 1. Phase 1 gets most of the practical benefit
(domain-specific checklists actually in the model's context) for zero
extra cost: it's prompt engineering with a classifier in front of it,
not a new inference path.

Verified isolated from the loop changes in the same session: with the
domain block forced to `''`, duration didn't change — confirming this
addition isn't what caused the latency observed elsewhere in the session
(see `ADAPTIVE_LOOP.md`).

## Phase 2 — not built yet

For `exploratory`-shaped tasks specifically (per `loop-profile.ts`'s
classification — that's where ambiguity actually benefits from multiple
angles), spawn 2-3 domain-relevant sub-agents in parallel via the existing
`spawn_task` / `makeDefaultSpawner` path, each in read-only mode with a
different domain framing, then synthesize.

Design constraints already decided, not yet implemented:
- **Read-only only** — parallel sub-agents writing files simultaneously is
  a race condition waiting to happen. Phase 2 sub-agents propose/diagnose;
  they don't edit.
- **Gated by task shape, not always-on** — only `exploratory` tasks pay the
  N-call cost. `single-file` and `multi-file` tasks stay on the Phase 1
  (single-agent, prompt-only) path.
- **Synthesis needs a real model call** — unlike classification, reconciling
  N expert opinions into one answer is actual judgment, not pattern
  matching, so this step isn't free. Worth benchmarking whether the
  quality gain justifies it before wiring it in by default.

Next step when picked back up: extend `spawner.ts`'s spawn path (or add a
new `runMixtureOfAgents()` in a new file) to fan out via `Promise.all`
instead of the current sequential single-spawn model, then benchmark
against a genuinely ambiguous fixture task (something `task-001` isn't —
that one has one right answer, which is exactly why it's a bad test for
whether multiple perspectives help).
