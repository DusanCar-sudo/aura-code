# Example: Dream Cycle

The full path from a day's work to a lesson Aura actually uses in future tasks.

## Step 1 — work happens, episodes accumulate

Every task you run — bug fixes, feature builds, research — gets recorded as an `Episode` in `episodes/*.json`: the task text, which model handled it, success/failure, duration. This happens automatically; nothing to invoke.

## Step 2 — consolidate

```
:dream
```

Reads episodes since the last dream, asks the LLM to distill them into four sections: `## Lessons`, `## Patterns`, `## Open threads`, `## Tomorrow brief`. Writes one dated file: `dreams/2026-06-29.md`.

## Step 3 — reconcile (automatic, once ≥3 dreams exist)

Once at least 3 dream files exist, `:dream` also runs reconciliation: it reads every dream, deduplicates and cross-checks claims, and assigns one of six verdicts to each — `KEEP`, `STRENGTHEN`, `MERGE`, `SUPERSEDE`, `CONFLICT`, or `DROP`. Confidence is mechanical: a lesson that shows up in 8 of 14 dreams gets `confidence: 0.57` — not a number the model invented, a ratio of how often it was independently observed.

Output: `dreams/.reconciled.md` — a single projection of current best understanding, with annotations showing where each belief came from.

## Step 4 — the lesson reaches the next task

`dreams/.reconciled.md` gets read by `context.ts` and injected into the system prompt under `### Memory (from past sessions)` for every future task in this project. The agent sees it alongside the project tree, README, and git history — not as a separate thing you have to ask for.

## Try it

```
:dream
:rem
```

`:rem` shows you the current reconciled projection (or the latest dream, if reconciliation hasn't triggered yet).
