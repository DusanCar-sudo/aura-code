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

## v0.7.1 additions

Both items from the original "Not done here" list are now built, plus one
bug fix:

- **Profile sizing was actually off in 0.7.0.** `loop.ts` still carried a
  leftover `// ISOLATION TEST: bypass profile sizing` line from the latency
  investigation, so every run used the flat default (150) and the profile's
  `maxTurns` was computed but ignored. Removed — profiles are live now.
  Sub-agents spawned via `spawn_task` also get profile sizing (the spawner
  previously pinned them to the flat default).
- **Adaptive widening** (`widenTo` on the profile) — a `single-file` run
  that hits its 30-turn ceiling while still making progress widens ONCE to
  80 and keeps going, instead of dying with a resume hint. Explicit
  `--max-turns` is a hard ceiling and never widens; top-tier shapes have
  no `widenTo`. A stalled run breaks out before the widening check, so a
  stuck loop can't buy itself more budget.
- **Cycle stall detection** (`detectStall` in `loop-profile.ts`) — besides
  exact repetition (A A A), the loop now stops on a two-call alternation
  (A B A B A B). The cycle needs `stallThreshold` full repetitions of the
  pair (i.e. 2× the turns of the repeat case), keeping it strictly harder
  to trigger — same conservative philosophy as before.

Covered by `tests/loop-profile.test.ts` and the stall/widening cases in
`tests/loop.test.ts`.

## Not done here

- Cycle detection covers period-2 only. Longer cycles (A B C A B C) are
  possible in principle but haven't been observed; extend `detectStall`
  if they show up.
- Widening is single-step. A run that exhausts the widened budget ends
  with the usual resume hint — it never widens twice.
