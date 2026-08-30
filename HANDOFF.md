# Handoff — 2026-08-30

Written mid-session against a weekly usage limit. Everything below is either
verified or explicitly marked as not.

**Repo:** `/mnt/bigdata/aura/aura-code`, branch `master`, version `0.17.0`.
**State:** build exits 0, `2750 tests passing / 9 skipped`.
**Last updated** after the workflow-authoring and chat-rename fixes below.
**Nothing from today is committed.** 31 tracked files modified, plus untracked
`src-tauri/`, `src/orchestration/marathon.ts`, `tests/orchestration/marathon.test.ts`.
Three older commits are on `master` and unpushed: `a556ec6`, `5f8318d`, `0deb54f`.

---

## If you are picking this up (agy, read this first)

1. **Do not clean the working tree.** No `git stash`, no `git checkout .`, no
   `git clean`. It holds a day of verified work plus another agent's ~11k
   uncommitted lines in `web/`. None of it is recoverable if discarded.
2. **Run the tests before and after.** `npm test` should report
   `2750 passed / 9 skipped` before you change anything. If it does not, stop and
   say so rather than building on a tree that is already broken.
3. **`npm run build` must exit 0.** It now typechecks `web/` first, on purpose.
4. **Commit only what you touched.** Stage explicit paths, never `git add -A`.
   `web/` belongs to another agent — do not commit their files, and do not
   "fix" the design-hook findings there.
5. **Push only after the full suite passes.** Branch is `master`; remote is
   `dusancar`. Do not cut a GitHub Release or publish to npm — those are the
   user's calls, and both are irreversible.
6. Ask before anything that spends tokens or runs an agent against the repo.

---

## The next task: serialise writers ("nerds")

This is the chosen direction. It replaces the worktree/shared-mutex idea
entirely — do not build worktrees.

**The problem, confirmed:** two different board tasks run concurrently with no
coordination. The only guard is per-task — `src/protocol/handler.ts:736` refuses
to re-run a task already in `execution` — and there is no locking in the write
tools. Two agents editing the same file today is last-write-wins, silently, with
no error and nothing to diagnose it from afterwards.

**The design:** let any number of *read-only* tasks run in parallel, since they
cannot corrupt anything. Allow only one *write-capable* task in `execution` at a
time; queue the rest.

**The pieces already exist.** `AGENT_PRESETS` in `src/board/agents.ts` carries a
read-only ceiling, and `effectivePermission` already treats read-only as a hard
cap that the operator's choice cannot raise. So "is this task a writer?" is
answerable from data that is already there — do not add a second notion of
permission alongside it.

**Where it goes:** `boardRun` in `src/protocol/handler.ts` (around line 736,
beside the existing execution guard). A queued task should be visibly queued on
the board rather than silently delayed — the Execution column already renders
state, so give it a "waiting" state instead of inventing a new column.

**Why not worktrees:** every worktree needs its own `node_modules` (minutes and
gigabytes per task), build artifacts and caches diverge so "run the tests" means
something different per tree, and merging back is the actual work — FIRSTMATE
needs a whole separate tool (`treehouse`) plus three delivery modes to land
results. Weeks of plumbing to own forever, for a hazard that serialising writers
removes outright.

---

## Done today, and verified in a browser

Verified means: run against a live server at `127.0.0.1:7337`, observed on
screen, and — where it persists — confirmed on disk in
`~/.aura/boards/aura-code-*.json`.

**The blank page.** The web client rendered an empty navy `<body>`. Cause:
`ReferenceError: saveModalOpen is not defined` thrown during React's first
render, which unmounts the tree; nothing reached the console because React's
scheduler swallows it. `web/src/components/Canvas.tsx` had a whole workflow-graph
and sticky-note feature where the JSX and every handler existed but the
`useState` declarations were missing — the tell was `INITIAL_WORKFLOW_NODES`,
`INITIAL_WORKFLOW_EDGES` and `DEFAULT_NOTES` sitting declared and unused. Added
the missing state and handlers. **154 typecheck errors → 0.**

**Build gate.** `build:web` was `vite build`, which does not typecheck, so a
bundle referencing undefined variables shipped clean and crashed at runtime. It
now runs `tsc -p web/tsconfig.build.json` first — that config keeps `strict` and
drops only `noUnusedLocals`, because an unused local is untidy but never broken,
and blocking releases on it teaches people to bypass the gate. **This is what
stops the blank-page class of bug; do not remove it.**

**Token auth.** `getAuthToken()` checked storage before Tauri IPC. The server
mints a new token per run into `~/.aura/active_token`, but web storage survives
runs — so the app kept replaying the previous run's token and 401'd forever.
IPC is now checked first under Tauri. Added `clearCachedToken`/`refreshAuthToken`,
a single 401 retry in `authFetch`, and token re-resolution before a WebSocket
handshake that never reached `open`. Also fixed two places reading `?token=`
straight off `window.location`, which is always empty at `tauri://localhost`.

**Kanban modal persistence.** Edits were written only by the SAVE button, so
closing any other way discarded them. Every exit now routes through
`closeDetail()`, which flushes first; fields also commit on blur. The modal task
is now derived from the board by id rather than held as a snapshot, and the
seeding effect is keyed on the **id**, not the object — keying it on the object
re-seeds mid-edit and wipes typing whenever the board changes. Escape now closes
the modal, which its `× [ESC]` button had always promised.

**Workflow steps.** `workflow` was never persisted at all — the engine's
`BoardTask` had no such field, so pipelines lived only in the browser. Added it
through the type, `TaskPatch`, `addTask`, the handler allowlist, and an
`isWorkflowDef` validator that rejects malformed graphs before they reach the
board file. Steps are now editable and removable in the task modal; removing a
step takes its edges with it. Step edits are buffered and flushed on blur —
writing per keystroke rewrote the whole board file per character.

**Terminal height.** The cap was `window.innerHeight * 0.75`; it now measures the
real container, so the terminal covers the editor entirely with only the drag
handle reserved. Double-click cycles collapsed → split → full.

**Composer theme.** `.composer-input-row` was a hardcoded dark gradient, so
`color: var(--ink)` put near-black text on near-black in light mode. Now driven
by `--ctl-*` tokens defined per theme. Resting height is four lines, derived from
line-height rather than pixel constants.

**Marathon.** Cut back to what it actually is. `shared-environment.ts` is gone,
replaced by `src/orchestration/marathon.ts` — `MarathonManager` only, with the
24-hour expiry actually implemented (computed on read, not by a timer that would
hold the process open). Added `:marathon off` and `:marathon status` to **both**
the CLI and the web handler. The banner now states only what the code does,
including that nothing in the run loop reads the flag yet.

Also fixed: the `:marathon` branch in `turnSend` returned **before** the
`activeTurn` and `budget.exhausted()` guards, making it a way to start a second
concurrent turn and to keep spending past an exhausted budget. It now obeys both.

**Workflow authoring.** The reported blocker: in the Canvas graph you could not
write what a step should do. Node name and description were read-only `div`s and
every new node got canned filler from a `titles`/`descs` table, so every pipeline
said the same four things. Name, description and (for tool nodes) the tool are
now editable on the card. Two things that broke it on the way: a pointerdown on a
field started a card drag, so the card slid away as you clicked into it and the
text never focused — the drag handler now ignores `input, textarea, select`; and
new nodes are created with an empty description so the placeholder asks what the
step should do, rather than filler that must be deleted and reads as finished.

**Chat rename.** New `session.rename` protocol method — trimmed, capped at 200
chars, empty clears back to the placeholder. `renameChat` in `useAura`, and a
pencil per row in the sidebar plus double-click on the title; Enter commits,
Escape abandons, blur saves. Two defects caught in testing: the field seeded with
the old name and put the caret at the end, so the first rename *appended*
(`UntitledSerialise writers`) — it now selects on focus; and the placeholder
sample chats were offering rename and delete, which would call the engine with an
id it has never seen, fail, and be swallowed. Those controls are hidden until
there is real history.

Note sessions are in-memory: reloading the page drops them and the sidebar falls
back to `DEFAULT_SAMPLE_CHATS`. That is pre-existing, not something rename broke.

### Two drift tests worth keeping

`tests/board/workflow.test.ts` now has two. The first checks every `TaskPatch`
field appears in the handler allowlist. The second checks every field is actually
**assigned in `updateTask`** — added because `workflow` passed the handler,
reached `updateTask`, and was dropped in silence, so removing a pipeline step
appeared to work and did not. Both were confirmed to fail without their fixes.

---

## Not done, and why

- **No GitHub Release for v0.17.0**, so npm is still on `0.15.5`. Publishing is
  public and irreversible — the user's call on timing and wording.
- **Tauri shell untested.** `cargo check` is clean and the token/PTY logic reads
  right, but everything was verified through a browser at `127.0.0.1:7337`, not
  `tauri://localhost`. The IPC-token and native-PTY branches have never executed.
- **`RUN PIPELINE` never fired.** It creates a task then calls `boardRun`. Every
  line up to that call is verified; the call itself spends tokens and turns an
  agent loose on the repo, so it is the user's to press.
- **`src-tauri/` is untracked.**

## Do not touch

- **`web/` is another agent's active work** — 11k uncommitted lines, a second
  `--acc`/`--acc2` palette living alongside the documented one in `theme.css`.
  Today's edits there were behavioural only (modal state, flush-on-close,
  workflow steps); no visual values were changed.
- **The impeccable design-hook findings in `Board.tsx`** (10 of them) are that
  agent's cyan direction measured against a `DESIGN.md` documenting the palette
  they are replacing. Leave them: fixing converts their in-flight work, and
  suppressing writes a shared waiver blessing a direction that is not ours.

## Also today, outside this repo

`aura-mic` was extracted from the `dic` command and published public:
https://github.com/DusanCar-sudo/aura-mic — source at
`/mnt/bigdata/aura/projects/aura-mic/`. Not on npm. aura-code still has its own
copy of `src/tools/dictate.ts` (used at `src/cli/index.ts:3617` for `speakText`),
so the two are duplicated until that publish happens. The global `dic` command
and the keyd hotkey were deliberately left untouched.

Note the coupling: `~/.local/bin/dic-toggle-run` execs
`/mnt/bigdata/aura/aura-code/dist/cli/dic.js` — **this working tree's build**. A
broken build here takes the user's dictation down system-wide.
