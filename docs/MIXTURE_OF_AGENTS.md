# Mixture of Agents — Phase 1: Domain Expertise · Phase 2: Parallel Perspectives

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

## Phase 2 — live in v0.7.1 (opt-in via `--moa`)

`src/agent/mixture.ts` (`runMixtureOfAgents`) + a gate in `src/cli/index.ts`.

For `exploratory`-shaped tasks (per `loop-profile.ts`'s classification —
that's where ambiguity actually benefits from multiple angles):

1. `classifyDomains(task)` picks up to 2 domain lenses; a `generalist`
   lens is always added (fallback pair `architecture` + `generalist` when
   nothing matches). Net: 2-3 perspectives.
2. Each lens runs a full agent loop in parallel (`Promise.all`) with
   `PermissionSystem('read-only')`, `disableSpawn: true` (one level of
   parallelism only), and a muted display (warnings/errors still surface,
   prefixed with the lens name).
3. One real `provider.complete()` synthesis call reconciles the reports —
   agreement stated plainly, conflicts weighed by confidence/evidence.
4. Returns a normal `LoopResult` (aggregated turns/usage/cost, including
   the synthesis call) so the CLI treats it like any single-agent run.

All the design constraints from the original plan held:
- **Read-only only** — perspectives diagnose; they never edit.
- **Gated by task shape AND `--moa`** — the N-call cost stays off the
  default path until benchmarks justify it. Passing `--moa` on a
  non-exploratory task warns and runs the normal single-agent path.
- **Synthesis is a real model call**, and its tokens/cost are counted in
  the returned result.

Covered by `tests/mixture.test.ts` (fan-out counts, synthesis input,
all-perspectives-failed short-circuit).

## Not done here

- No benchmark yet against a genuinely ambiguous fixture task (something
  `task-001` isn't — it has one right answer, which is exactly why it's a
  bad test for whether multiple perspectives help). Until that exists,
  `--moa` stays opt-in.
- The REPL path doesn't offer MoA; only single-shot `aura --moa '<task>'`.
