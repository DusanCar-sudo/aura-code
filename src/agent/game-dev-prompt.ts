/**
 * Game-development mode expertise (:gamedev, :gamedev-heavy).
 *
 * Appended to the system prompt when the session is in a game-dev mode. This
 * is session state, not task text, so it rides on the system prompt rather
 * than task-guidance.ts — the same trade-off the orchestration callers make
 * (loop.ts drops buildTaskGuidance when the caller owns the prompt): the mode
 * IS the domain guidance, deterministic instead of keyword-guessed. Memory,
 * confessions, skills and study pins all stay — they live inside
 * buildSystemPrompt, whose output this composes with.
 *
 * Tooling: 3D assets go through Kiln (instruktlabs/kiln — procedural
 * .kiln.js programs, rendered review, GLB export) over the `mcp` tool or its
 * CLI; C++/Vulkan/Lua engine work carries Traktor-specific conventions. Both
 * are guidance only — neither is required for plain gameplay work.
 */

export function isGameDevMode(mode: string): boolean {
  return mode === 'gamedev' || mode === 'gamedev-heavy';
}

/** The core game-dev expertise. Engine-agnostic unless a project is clearly
 *  engine-bound; the Kiln and Traktor sections name their own triggers. */
const GAMEDEV_CORE = `

## Game development discipline
- Frame safety first: the per-frame path allocates nothing steady-state (no object churn in the loop), caches lookups hoisted out of tick/update, and no unbounded growth (pools, not new arrays per frame).
- Time is delta-time everywhere: movement, timers, cooldowns and tweens scale by dt; no frame-count-based logic. Fixed-timestep simulation (with interpolation) for physics; variable dt for presentation.
- Game state lives in explicit state machines or utility scores — never in scattered booleans. Transition tables are data, reviewable and testable.
- AI decisions prefer Utility AI (score each consideration, pick the best — considerations are small pure functions) for graded, emergent behavior, and behavior trees for ordered, interruptible routines (sequences, selectors, decorators with guards). Hybrid is normal: BT for structure, utility scores to choose branches. Never a 40-case switch.
- Decouple simulation from presentation: the simulation is deterministic and headless-testable; rendering, audio and juice read from it. This is what makes run_tests able to verify gameplay.
- Input is a mapped abstraction (actions, not raw keys), consumed once per frame, with buffering where responsiveness matters.
- Content is data: tuneables, balance tables, spawn tables and level layouts live in data files, not hardcoded constants buried in logic.
- Every change runs the game's tests/headless checks where they exist; a rendering-only change says so instead of claiming gameplay verification.`;

/** Kiln pipeline — 3D asset authoring and revision through the coding agent. */
const GAMEDEV_KILN = `

## 3D assets via Kiln
- Kiln (instruktlabs/kiln) is the asset pipeline when this project uses it: the agent writes a JavaScript program with Kiln's geometry/material helpers (.kiln.js), Kiln renders review views back, and the asset exports as GLB with its source kept for revision.
- Check for a configured Kiln MCP server first (mcp tool, action list_servers / connect server=kiln — servers live in ~/.aura/mcp.json); fall back to its CLI (kiln render --out x.glb --views sheet.png) only when MCP is not wired.
- Revise, never re-author: keep the programRef, apply kiln_edit with targeted oldString/newString edits, re-render to review, then save. One brief = one program source, many revisions.
- Review renders before declaring done: silhouette, scale, part attachment close-ups (kiln_render capture with subject paths). CPU renders judge shape, not materials — say so rather than certifying PBR appearance.`;

/** Traktor conventions — lean C++ engine, Vulkan, Lua scripting. */
const GAMEDEV_TRAKTOR = `

## Traktor engine work (C++ / Vulkan / Lua)
- When the project is Traktor-based: engine changes stay lean — minimal footprint, data-oriented layouts, no per-entity virtual dispatch in hot paths.
- Vulkan resources follow acquire→use→release discipline per frame; descriptor sets and command buffers are pooled and re-recorded, not allocated. Synchronization (barriers, semaphores) is explicit — never assume implicit ordering.
- Gameplay logic lives in Lua scripts against the engine API; C++ changes are reserved for engine features, not content. Script-facing APIs are documented and versioned.
- Ray-tracing features degrade gracefully: a fallback path exists and is what the tests exercise.`;

/** Heavy mode adds a standing verification rubric — the same checklist the
 *  self-verification pass grades against, stated up front so the first run
 *  already aims at it. */
const GAMEDEV_HEAVY = `

## Heavy-mode rubric (verification grades against this)
- Frame budget: steady-state allocations, per-frame lookups, and O(n²) over entity counts called out and eliminated where found.
- Time correctness: every simulation path is dt-scaled; pause/resume and tab-refocus do not produce a dt spike (clamp dt).
- State hygiene: no orphaned state on scene transitions (listeners, timers, tweens, spawned entities all torn down or pooled).
- AI sanity: utility scores are bounded and debuggable (dumpable); BT guards prevent double-ticks.
- Verification runs the game's own tests/headless entry point and reports concrete output — not "should work".`;

export function gameDevPromptBlock(heavy: boolean): string {
  return GAMEDEV_CORE + GAMEDEV_KILN + GAMEDEV_TRAKTOR + (heavy ? GAMEDEV_HEAVY : '');
}
