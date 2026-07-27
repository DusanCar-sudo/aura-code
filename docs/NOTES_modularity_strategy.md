# Notes: Modular Orchestration Strategy track

## What was built

New file: `src/orchestration/strategy.ts` (compiles clean, `npx tsc --noEmit` passes).

- `OrchestrationStrategy` interface — `name`, `run(task, opts)`, optional `getStats()`.
- `StrategyRunOptions` / `StrategyRunResult` — generalization of
  `AlternatorOptions` / `AlternatorRunResult`. The two hardware-specific fields
  (`archimedesConfig`, `largeModelProvider`) moved out of run options into per-strategy
  constructor state; everything session-shaped (context, display, permissions,
  confirmFn, initialHistory, abortSignal, healthTracker) stayed in run options.
- `BaseOrchestrationStrategy` abstract class — carries the safety contract:
  1. missing `permissions` defaults to `'normal'`, never `'auto'` (enforced in
     `run()` before any strategy body executes);
  2. `untrustedPermissions()` helper returns a fresh read-only
     `PermissionSystem` for any unproven model — the "Archimedes always read-only"
     rule expressed as a contract property, not alternator trivia.
- `ArchimedesAlternatorStrategy` — wraps `ArchimedesAlternator` **unchanged** (new instance
  per run, since `AlternatorOptions` carries per-run state). Proves the
  interface fits the existing implementation with zero edits to `alternator.ts`.
- `SingleModelStrategy` — one model, no alternation/escalation/episodes.
  Powerful-local-machine case. Fully functional, not just a stub.
- `selectDefaultStrategy()` — capability detector: Archimedes enabled + Ollama
  reachable → alternator strategy; otherwise single-model. Ollama ping
  duplicated from alternator.ts (private there; see proposals).

## What I found in the existing orchestration files

- `ruby-detect.ts` / `ruby-types.ts`: **Ruby the programming language**, not
  Archimedes the small model. Detects Rails/Sinatra/Gemfile etc. Nothing reusable for
  hardware/model detection — the handoff's hunch was wrong. Name collision is
  a real confusion hazard ("Archimedes Principle" small-model vs Ruby-lang project
  context); worth a rename discussion.
- `competence.ts` (orchestration): specialist-role competence (researcher/
  coder/reviewer/planner per domain), disjoint from `src/archimedes/competence.ts`
  (task-pattern gating for the small model). No overlap with this track.
- The only real local-capability probe in the codebase is
  `isOllamaAvailable()` inside `alternator.ts` (private). `src/archimedes/
  model-selector.ts` picks among *large* models from episode history —
  orthogonal, could later inform a multi-model strategy.

## Proposed (NOT applied) changes to alternator.ts

Reconcile against the other track's in-flight edits:

1. Export `isOllamaAvailable` (or move to a shared `src/archimedes/ollama.ts`).
   `strategy.ts` currently duplicates the ping verbatim.
2. Export `createNoopDisplay` (also duplicated in `strategy.ts`), or move to
   `src/cli/display.ts` as the natural home.
3. Optional, cosmetic: `ArchimedesAlternator` could `implements` the interface
   directly if its `run(task)` grew an optional second parameter — not needed,
   the wrapper works fine.
4. Longer term: alternator's internal read-only `PermissionSystem` for the Archimedes
   attempt could be sourced from `BaseOrchestrationStrategy.untrustedPermissions()`
   once ArchimedesAlternator itself lives behind the strategy layer.

## Unresolved for the human

- Where the CLI adopts strategies: `src/cli/index.ts:985` and `:1219` construct
  `ArchimedesAlternator` directly. Swapping those to `selectDefaultStrategy()` (with
  a config override, e.g. `.aura.json` `orchestrationStrategy` key) is the next
  step, deliberately not done while the other track edits nearby code.
- Config surface for forcing a strategy (auto-detect vs explicit name).
- Whether `SingleModelStrategy` should also capture episodes (currently no —
  no alternation means no training signal, but stats parity may matter).
- The Ruby-lang vs Archimedes-model naming collision in `src/orchestration/`.
- Local fine-tune strategy (third candidate from the handoff) not stubbed —
  interface accommodates it (`details`/`getStats` are open-typed), but its
  shape depends on decisions in `src/archimedes/fine-tune.ts` owned elsewhere.
