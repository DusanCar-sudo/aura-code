# Example: Feature Build

A larger task spanning multiple files — where orchestration mode helps.

## Task

```
aura --orchestrate "add rate limiting to all API endpoints"
```

## What happens

Orchestration mode decomposes the task into a plan before any code is written:

1. **Plan** — identifies which endpoint files exist, what a consistent rate-limiting approach would look like across them, and what order to apply changes in.
2. **Execute, per file** — each affected endpoint gets the same rate-limiting pattern applied, not five different inconsistent implementations.
3. **Verify** — runs the full test suite after each significant change, not just once at the end, so a regression in file 2 doesn't get masked by files 3-5.
4. **Report** — a single summary covering every file touched, not five separate ones.

## When to use `--orchestrate` vs. a plain task

Plain `aura "task"` is correct for single-file, well-scoped changes (see [`01_bug_fix.md`](01_bug_fix.md)). `--orchestrate` is worth the extra planning overhead when a task genuinely spans multiple files that need to stay consistent with each other.

## Try it

```
aura --orchestrate "<describe a multi-file feature you need>"
```

For a preview of the plan before anything runs, add `--plan`:

```
aura --orchestrate --plan "<task>"
```
