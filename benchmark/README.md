# Aura Benchmark

Reproducible, scored tasks for measuring Aura's actual performance — not vibes.

## Reproducibility contract

- Each `fixtures/<task>/before/` is a fixed starting state, versioned in git.
- Every run copies `before/` fresh into a temp dir — never mutated, never reused.
- The prompt and verify command live in `task.json` — identical inputs every run.
- Scoring is pass/fail against a real test suite (`verify`), not "did it exit 0."

This means: run the same task twice, get comparable numbers. Change the model
or the prompt, and the diff in pass rate / duration is the actual signal —
not noise from a fixture that silently drifted.

## Layout

```
benchmark/
  run.mjs                          # runner
  fixtures/
    task-001-off-by-one/
      task.json                    # { prompt, verify }
      before/                      # starting file state, copied fresh each run
  results/                         # timestamped JSON output (gitignored)
```

## Usage

```bash
# Sanity-check fixtures without invoking Aura (fast, free)
node benchmark/run.mjs --dry-run

# Run everything once
node benchmark/run.mjs

# Run a specific task
node benchmark/run.mjs task-001

# Run 3x for variance (same fixture, same prompt, different agent runs)
node benchmark/run.mjs --runs 3
```

Requires `aura` on `PATH`.

## Adding a task

1. `mkdir -p fixtures/task-00N-<name>/before/<real file paths>`
2. Write the buggy/incomplete starting state into `before/`.
3. Write a test file that **fails on the starting state and passes on a correct fix**
   — verify this manually before trusting the fixture (see task-001 as a template).
4. Write `task.json`:
   ```json
   { "prompt": "...", "verify": "node --test path/to/test.js" }
   ```
5. `node benchmark/run.mjs task-00N --dry-run` to confirm it copies cleanly.

## What this does NOT do (yet)

- No cost/token tracking — `episodeCount` is a proxy, not a real cost metric.
- No human-baseline comparison — this measures Aura against itself (model
  swaps, prompt changes, version changes), not against a human doing the same task.
- Single verify pass/fail — no partial credit, no code-quality scoring.

These are the next things worth building once the base harness has real data
in it. Don't add them speculatively — add them when the first real numbers
show what's actually missing.
