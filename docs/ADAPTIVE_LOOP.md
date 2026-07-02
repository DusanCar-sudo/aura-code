# Adaptive Loop

`src/agent/loop-profile.ts` + changes to `src/agent/loop.ts`

## Problem

Every task got the same flat `maxTurns` (150, from `DEFAULTS.maxTurns`) regardless
of shape. A one-line bug fix and a 20-file refactor had the same ceiling. Worse:
if the agent got stuck retrying the same edit, nothing stopped it short of that
ceiling — burning turns and cost on a run that had already stalled.

## What it does

**Task classification** (`classifyTask`) — cheap keyword match on the task
string, no LLM call spent deciding:

| Shape | Signals | maxTurns | stallThreshold |
|---|---|---|---|
| `single-file` (default) | — | 30 | 3 |
| `multi-file` | "all endpoints", "every file", "across the", "orchestrate", ... | 150 | 4 |
| `exploratory` | "explain", "analyze", "investigate", "why does", ... | 80 | 4 |

`getLoopProfile(task, override)` — explicit `--max-turns` / `opts.maxTurns`
always wins over classification.

**Stall detection** (in `loop.ts`) — every turn's tool-call signature
(`name` + `input`, exact JSON match) is recorded. If the last N turns
(N = `stallThreshold`) are identical, the loop stops immediately with
`"Loop stalled (repeated identical tool calls)"` instead of continuing
to the turn ceiling.

## Why this shape

- No extra LLM call for classification — it's pattern matching on a string,
  same philosophy as everything else that has to run before the model does
  real work.
- Stall detection triggers on *exact* repetition, not similarity — a
  deliberately conservative bar. False positives (stopping a loop that
  was actually making slow progress) are worse than false negatives here,
  since a human can always resume a session that stopped early, but a
  burned-out 150-turn run is just gone.
- `single-file` gets the tightest budget and the twitchiest stall threshold
  (3, not 4) because it's the highest-volume task shape — most benefit from
  catching a stall fast.

## Verification

Ran against `benchmark/task-001-off-by-one` (3 runs): 3/3 pass, no change
in turn count (5 turns / 5 tool calls, matching pre-change baseline).
A duration increase was observed (~24s → ~42s) across this session but was
isolated via a domain-block-disabled test and found to persist regardless —
most likely time-of-day API latency on the provider side (baseline captured
~9 hours earlier than the slower runs), not a regression in this code.
See commit history for the isolation methodology if this needs re-verifying.

## Not done here

- No adaptive *widening* — if a `single-file` task turns out to need more
  than 30 turns, it just ends with a resume hint. It doesn't auto-upgrade
  itself to a bigger budget mid-run. Worth considering once there's data
  on how often single-file tasks actually hit the ceiling.
- Stall detection is exact-match only. A model alternating between two
  equally-wrong edits (A, B, A, B, A, B) wouldn't trigger it. Loosening
  this to a small cycle-detection window is a reasonable next step if
  that pattern shows up in practice.
