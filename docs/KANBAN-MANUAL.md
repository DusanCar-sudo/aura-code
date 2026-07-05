# Aura Code — Kanban Pipeline Manual

> **This board is not AI-connected.** No LLM call happens anywhere in this
> pipeline. Every phase handler is hardcoded, deterministic logic — regex
> pattern matching, file existence checks, keyword search, real (but
> static) git/filesystem reads. It exists to help you organize and see your
> ideas coherently laid out, with honest numbers instead of guesses. When
> you're ready to actually do the work — edit files, run commands, make
> real changes — that happens through `aura` on the CLI, where the actual
> agent reasoning lives.

A structured, visual way to lay out a set of tasks and get a real read on
your codebase before you start: real file counts, real test counts, real
build-output checks, real git history. Every column and card does genuine
filesystem analysis — none of it is simulated, and none of it is an AI
deciding anything.

---

## Quick Start

```bash
aura kanban              # start on localhost:7474
aura kanban --port 8080  # custom port
```

Open the printed URL in your browser. The board renders, the controls are
live, and clicking **▶ Execute Pipeline** runs real work against your actual
project — there's nothing to configure first.

---

## The Board, at a Glance

Five columns (pipeline phases) × four rows (agent modes) = 20 cells. Each
cell holds a task card or an empty slot you can fill in yourself.

```
              Read        Plan        Execute     Verify      Report
            (Context)   (Strategy)   (Ignite)     (Test)      (Done)
 ┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
 │Orchestrate│  card    │          │  card 🔴 │  card    │  card    │
 ├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤
 │Architect  │  card    │  card    │          │  card    │          │
 ├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤
 │Verify     │          │  card    │  card 🔴 │          │          │
 ├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤
 │RubyAlter  │          │  card    │          │  card    │  card    │
 └──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
```

A task **starts** in its origin column and runs through every phase to its
right. A task that starts in "Execute" skips Read and Plan entirely — it
goes straight to Execute → Verify → Report.

**Rows run one at a time, top to bottom.** This matters for what a task can
honestly know about its neighbors — see the Report column below.

---

## The Five Phases

| Phase | What actually happens |
|---|---|
| **Read** | Scans your source tree, reads key files, estimates a token budget for the task |
| **Plan** | Analyzes the task and related files, suggests an approach based on the row it's in |
| **Execute** | Scans affected files, counts exports/functions/classes, checks test coverage |
| **Verify** | Checks build output, counts real test files and cases, scans for TODOs and empty catch blocks |
| **Report** | Summarizes what actually happened — for the row's own completed tasks, plus real git history |

None of this is simulated. "Verify" genuinely reads your `tsconfig.json` and
checks whether `dist/` exists; it counts real `it(`/`test(`/`describe(`
occurrences across your actual test files. The numbers you see are real
numbers from your actual codebase at the moment you click Execute.

**One honest limit worth knowing:** "Verify" checks whether a build
*already exists* (`dist/` is present) — it doesn't run `npm run build` live
during the pipeline. If your source has changed since the last real build,
a stale `dist/` could still show as "✓ functional." Run your own build
separately if you need a guarantee about the current state.

---

## The Four Rows

| Row | Represents |
|---|---|
| **Orchestrate** | Multi-agent routing, planning, specialist dispatch |
| **Architect** | High-level design, schema analysis, build integrity |
| **Verify** | Self-correction — analyzing failures, planning fixes |
| **RubyAlternator** | The self-improvement subsystem — competence scoring, episode logging |

---

## Interacting with the Board

- **Click a card** → edit modal opens, pre-filled with its current data.
- **Click an empty slot** → same modal, blank — fill it in to create a new
  task in that cell.
- **Clear Slot** (in the modal) → removes the card, restores the empty
  placeholder.
- **▶ Execute Pipeline** → runs every task on the board through its phases.
  Progress streams live over WebSocket: gold while running, green on
  success, red on failure.
- **📋 Show Report** → the full execution report — aggregate stats, then a
  per-row breakdown of every task's real phase outputs.
- **🌙 Dark Mode** → toggles theme, saved in your browser's local storage.

---

## Worked Example 1 — Running the Default Board

1. `aura kanban`, open the URL.
2. Click **▶ Execute Pipeline**. Watch the log at the bottom — you'll see
   each task's phases light up gold, then green, in row order: every
   Orchestrate task finishes completely before any Architect task starts.
3. Click **📋 Show Report**. Scroll to the Orchestrate section — you'll see
   "PR Generation" listing the *real* results of its three row-mates
   (Token Optimization, File Patch Operations, 1000+ Test Run), each with
   their actual completion status, followed by your project's actual last
   5 git commits. It will also tell you plainly that it can't report on
   Architect/Verify/RubyAlternator yet — because at that point in
   execution, they genuinely haven't run.
4. Try `/api/report.md` directly in a browser tab, or:
   ```bash
   curl http://localhost:7474/api/report.md
   ```
   Same report, as portable Markdown — useful for pasting into a PR
   description or piping into another tool.

---

## Worked Example 2 — Adding a Custom Task

Say you want the board to track something specific to your work right now:
checking error handling in the provider layer.

1. Click any empty slot — say, **Execute** column, **Architect** row.
2. Fill in:
   - **Objective Title:** `Provider Error Handling`
   - **Details:** `Check try/catch coverage across all provider modules`
   - **System Tag:** `TypeScript`
3. Save, then run the pipeline.

Here's what happens under the hood, since it's worth understanding rather
than treating as a black box: the board has no special-case logic for
"Provider Error Handling" — it's not one of the 12 built-in tasks. So the
**generic handler** takes over. It pulls keywords from your title and
description, dropping only common function words (*the*, *and*, *with*,
*from*, and the like) — verified against this exact example, it extracts
`provider`, `error`, `handling`, `check`, `try`, `catch`, `coverage`,
`across`, `all`, `modules`. It then searches your actual `.ts` files for
those terms, ranking results by how many keywords each file contains.
You'll see real file paths, real line counts, and a real snippet from the
matching line — not a placeholder. The same mechanism handles *any* task
you create; more specific, descriptive text produces more relevant file
matches.

---

## API Reference

| Endpoint | Method | Returns |
|---|---|---|
| `/` | GET | The interactive board |
| `/api/tasks` | GET | All board tasks as JSON |
| `/api/execute` | POST | Runs the full pipeline; returns the report |
| `/api/report` | GET | Last execution report (JSON) |
| `/api/report.md` | GET | Last execution report (Markdown) |
| `ws://localhost:<port>` | WebSocket | Real-time phase/row/pipeline progress events |

### WebSocket event shapes

```json
{ "type": "phase_start", "taskId": "exec-orch-filepatch", "phase": "execute", "row": "orchestrate" }
{ "type": "phase_done",  "taskId": "exec-orch-filepatch", "phase": "execute", "status": "done", "output": "..." }
{ "type": "row_done",    "row": "orchestrate", "status": "done" }
{ "type": "pipeline_done", "message": "{\"totalTasks\":12,\"completed\":12,\"failed\":0,\"skipped\":0}" }
```

`POST /api/execute` returns `409` if a pipeline run is already in progress
— only one run executes at a time.

---

## Task Status Reference

| Status | Meaning |
|---|---|
| `pending` | Not yet started |
| `running` | Currently executing |
| `done` | Completed successfully |
| `failed` | Encountered an error — remaining phases for that task are skipped |
| `skipped` | Bypassed because an earlier phase for the same task failed |

---

## Architecture

```
aura kanban
  └─ src/kanban/
       ├── index.ts     — public exports
       ├── types.ts     — KanbanTask, PipelinePhase, PipelineReport, etc.
       ├── pipeline.ts  — the engine: 12 built-in tasks, 5 phase handlers,
       │                  generic handlers for custom tasks
       └── server.ts    — Express + WebSocket server, board UI, API routes
```

Each row runs to completion before the next row starts. A task's Report
phase can only honestly reference results from tasks **in its own row**
that ran before it — cross-row results genuinely don't exist yet at that
point in execution. The full, accurate cross-row picture is always
available afterward in the aggregate report (`/api/report` or
`/api/report.md`), which is built from the real results of every task,
every row.
