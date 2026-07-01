# Example: Bug Fix

A simple, single-file bug fix — the most common Aura task.

## Task

```
aura "fix the off-by-one error in src/utils/pagination.ts"
```

## What happens

1. **Reads** — Aura reads `pagination.ts` and any tests that cover it, rather than guessing at the bug from the filename alone.
2. **Plans** — identifies the actual off-by-one (e.g. `<=` where `<` was needed in a loop bound).
3. **Executes** — applies a targeted edit via `edit_file`, not a full-file rewrite.
4. **Verifies** — runs the test suite (or the specific test file) to confirm the fix doesn't break anything else.
5. **Reports** — summarizes what changed and which tests passed.

## What gets recorded

This task becomes one `Episode` in `episodes/*.json` — task text, model used, success/failure, duration, token cost. Nothing more happens automatically from a single bug fix; the memory system (see [`04_dream_cycle.md`](04_dream_cycle.md)) only produces a real lesson once a *pattern* of similar tasks accumulates.

## Try it

```
aura "fix <describe your actual bug>"
```
