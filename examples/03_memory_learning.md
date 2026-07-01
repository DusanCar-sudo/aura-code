# Example: Memory Learning (Mining)

How Aura finds recurring patterns across past work, without any LLM call.

## The command

```
:mine
```

(run inside the Aura REPL, after at least a handful of related tasks have accumulated as episodes)

## What happens

`:mine` runs **Baby Ruby** (`src/mining/extract.ts`) — pure statistics, zero LLM calls:

1. Groups your episodes by category (`research`, `implementation`, `review`, `refactor`, `other`).
2. Within each category, recursively splits by keyword overlap — e.g. three separate "fix authentication bug" episodes cluster together even if you never explicitly grouped them.
3. Assigns a **mechanical** confidence score: `cluster size / total episodes`. Not a model's opinion — a ratio.

## Example output

```
✓ Found 6 pattern(s) from 70 episode(s) (45 unclustered).

  authentication_token_bug [implementation] freq=3 conf=0.18
    fix authentication token expiry bug
  database_migration_bug [implementation] freq=3 conf=0.13
    fix database migration ordering bug
```

## Going further: `:mine --refine`

```
:mine --refine
```

Adds **Papa Ruby** (`src/mining/refine.ts`) — a local model judges whether each statistically-found cluster is a *real, generalizable lesson* or just coincidental keyword overlap, and writes accepted lessons to `training-data/*.jsonl`.

## Try it

```
:mine
```

Needs at least a few related episodes to find anything — a single one-off task won't cluster into a pattern, by design.
