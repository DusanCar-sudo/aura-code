# Aura Code — Memory

> Most AI coding tools forget everything between sessions. Aura doesn't.

## How it works

```
You work with Aura
        ↓
Every task is recorded as an episode
        ↓
:dream consolidates episodes into lessons, patterns, open threads
        ↓
After 3+ dreams, reconciliation deduplicates and detects conflicts
        ↓
The reconciled projection is injected into the system prompt
        ↓
Aura uses past lessons to inform current tasks
```

This is not chat history. It's distilled experience — closer to how a human colleague remembers working with you than how a chatbot replays old messages.

## What gets stored

### Episodes

Every task Aura runs is captured as an **episode** in `episodes/`. Each episode records:

- The task you gave
- Which model ran it
- Whether it succeeded
- How long it took
- How many tokens it used
- What category it falls into (research, implementation, review, refactor, other)

Episodes are raw data. You never read them directly — they're input for the dream system.

### Dreams

When you run `:dream`, Aura consolidates recent episodes into a dated markdown file under `dreams/`. Each dream has four sections:

- **Lessons** — tagged generalizations (`[tooling]`, `[bug]`, `[routing]`). What was learned, abstracted beyond the single task.
- **Patterns** — recurring task shapes or failure modes seen across episodes.
- **Open threads** — unresolved problems worth picking up next session, prefixed with `[todo]`.
- **Tomorrow brief** — 2-4 sentences on what Aura should be ready for.

Dreams are **append-only**. Each day's dream is an immutable record. They are never modified after creation.

### Reconciled memory

After 3+ dreams exist, `:dream` automatically runs **reconciliation** — a pass that reads all dreams and produces a single projection: `dreams/.reconciled.md`.

This file is what Aura actually reads before each task. It contains the current best understanding of the project, with annotations showing where each belief came from.

## What gets ignored

- Chat history (conversation turns) is **not** part of the memory system. Sessions can be resumed via `:resume`, but they're not distilled into lessons.
- File contents are **not** memorized. Aura reads files fresh each time — memory is about *lessons and patterns*, not *data*.
- Failed tasks are recorded as episodes but don't produce lessons unless the failure reveals a pattern.

## Reconciliation verdicts

When reconciliation runs, every bullet from every dream gets one of six verdicts:

| Verdict | What it means |
|---|---|
| **KEEP** | Unique claim, no overlap with others. Retained as-is. |
| **STRENGTHEN** | Same claim appeared across multiple dreams. Confidence goes up. |
| **MERGE** | Two related but distinct claims combined into one. |
| **SUPERSEDE** | Newer claim replaces an older one. The old one is outdated. |
| **CONFLICT** | Two claims contradict each other. Both are surfaced — not resolved. |
| **DROP** | Exact duplicate. Removed from the projection. |

### Conflicts are surfaced, not hidden

When Aura's past beliefs contradict each other — for example, "user prefers minimal dependencies" from June 12 vs. "user now uses batteries-included frameworks" from June 20 — the system marks this as a **CONFLICT** and shows both. It does not silently pick one.

This matters because silent merging is how AI memory systems lie. Aura's approach is: show the contradiction, let the human or the next dream resolve it.

### Confidence is mechanical

Each bullet in the reconciled projection has a confidence score. This is **not** a model-generated number (LLMs produce meaningless confidence scores). It's computed from structure:

```
confidence = number of source dreams containing this claim / total dreams
```

A bullet that appears in 8 of 14 dreams has confidence 0.57. A bullet from a single dream has confidence 0.07. The number is defensible because it measures *frequency of independent observation*, not *how sure the model feels*.

## How memory reaches the agent

The reconciled projection (`dreams/.reconciled.md`) is read by `context.ts` at startup and injected into the system prompt under `### Memory (from past sessions)`. The agent sees it alongside the project tree, config, README, and git history.

The framing tells the agent: "Use these lessons to avoid repeating past mistakes and to continue unfinished work."

The memory section is **optional** — if no reconciled file exists (new project, fewer than 3 dreams), the prompt is identical to a memoryless agent. No degradation for new users.

## Commands

| Command | What it does |
|---|---|
| `:dream` | Consolidate today's episodes into a dream. If ≥3 dreams exist, also runs reconciliation. |
| `:dream full` | Consolidate ALL episodes, ignoring the last-dream cutoff. |
| `:rem` | Show the reconciled memory projection (or the latest dream if no projection exists). |
| `/stats`, `/usage` | Show episode-level statistics: completion rate, models used, token counts. |

## File layout

```
dreams/
  2026-06-24.md          ← immutable daily dream (append-only)
  2026-06-26.md          ← another day's dream
  .state.json            ← cutoff timestamp (newest episode covered by the last successful dream)
  .reconciled.md         ← the projection (materialized view, regenerated each :dream)

episodes/
  *.json                 ← raw episode data (one per task)
```

## Design philosophy

The memory system is modeled on **event sourcing**:

- Episodes are the **event log** — immutable, append-only, raw.
- Dreams are **snapshots** — periodic consolidations, also immutable.
- `.reconciled.md` is the **materialized view** — derived, regenerable, the only thing the agent reads.

This means you can always rebuild the projection from the raw data. Deleting `.reconciled.md` doesn't lose anything — the next `:dream` regenerates it.

## What makes this different

Most AI coding tools have one of:

- **No memory** — every session starts from zero.
- **Chat history** — raw conversation replay, grows unboundedly, no abstraction.
- **Context stuffing** — dump everything into the prompt, hope the model sorts it out.

Aura's approach is:

- **Experience → reflection → knowledge → behavior.** Episodes are raw experience. Dreams are reflection. Reconciliation is knowledge. The system prompt is behavior.
- **Conflicts are visible.** The system doesn't pretend to have a single coherent belief when it doesn't.
- **Confidence is earned.** Repeated observation across independent sessions increases confidence. A one-time observation stays low-confidence.
- **Memory is auditable.** Every belief traces back to specific dated dreams. You can read the lineage and decide whether to trust it.
