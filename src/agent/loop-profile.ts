/**
 * Task classification — used only to gate --moa (see cli/index.ts). Turn
 * budgeting itself does NOT depend on shape; see getLoopProfile below.
 *
 * Cheap heuristics only — no LLM call. Spending a model turn to decide
 * how many turns to allow defeats the purpose. This is pattern matching
 * on the task string, nothing more.
 */

export type TaskShape = 'single-file' | 'multi-file' | 'exploratory';

export interface LoopProfile {
  maxTurns: number;
  /** How many identical consecutive turn-signatures count as a stall. */
  stallThreshold: number;
}

const MULTI_FILE_SIGNALS = [
  'all endpoints', 'every file', 'across the', 'throughout the',
  'all files', 'each file', 'entire codebase', 'orchestrate',
];

const EXPLORATORY_SIGNALS = [
  'explain', 'analyze', 'investigate', 'research', 'understand',
  'why does', 'why is', 'how does', 'what causes', 'diagnose',
];

/**
 * Classify a task string into a rough shape. Defaults to 'single-file'
 * when nothing matches — the common case (fix X, add Y to file Z).
 */
export function classifyTask(task: string): TaskShape {
  const lower = task.toLowerCase();

  if (MULTI_FILE_SIGNALS.some((s) => lower.includes(s))) {
    return 'multi-file';
  }
  if (EXPLORATORY_SIGNALS.some((s) => lower.includes(s))) {
    return 'exploratory';
  }
  return 'single-file';
}

/** Default hard ceiling when neither --max-turns nor .aura.json set one. */
export const DEFAULT_MAX_TURNS = 150;

/** Default stall-detection sensitivity — same for every task, no ladder. */
export const DEFAULT_STALL_THRESHOLD = 3;

/**
 * Get the loop profile for a run.
 *
 * Modeled on pi's agent loop (github.com/badlogic/pi-mono,
 * packages/agent/src/agent-loop.ts): that loop has no turn-budget concept
 * at all — it runs until the model stops producing tool calls, full stop.
 * We keep a single flat ceiling as a safety net (unlike pi), but drop the
 * shape-based ladder + adaptive widening this used to have: sizing the cap
 * off task-shape guesses made the *default* look like an explicit
 * `--max-turns`, which silently disabled itself as a ceiling once the
 * config layer's fallback value flowed through the same field. One flat
 * number, checked once per turn, is simpler and cannot collide that way.
 *
 * @param override Explicit maxTurns from CLI flag or .aura.json.
 */
export function getLoopProfile(override?: number): LoopProfile {
  return {
    maxTurns: override ?? DEFAULT_MAX_TURNS,
    stallThreshold: DEFAULT_STALL_THRESHOLD,
  };
}

export type StallKind = 'repeat' | 'cycle';

/**
 * Detect a stalled run from the sequence of per-turn tool-call signatures.
 *
 * - 'repeat': the last `threshold` signatures are identical (A A A) — the
 *   agent retrying the same call verbatim.
 * - 'cycle':  the last `2 * threshold` signatures alternate between two
 *   distinct signatures (A B A B A B) — the agent bouncing between two
 *   equally-wrong edits. Requires `threshold` full repetitions of the pair,
 *   so it is strictly harder to trigger than 'repeat'.
 *
 * Exact-match only, deliberately conservative: a false stop on a run that
 * was making slow progress is worse than a few wasted turns, since a human
 * can always resume a stopped session.
 */
export function detectStall(signatures: string[], threshold: number): StallKind | null {
  const tail = signatures.slice(-threshold);
  if (tail.length === threshold && tail.every((s) => s === tail[0])) {
    return 'repeat';
  }

  const pairTail = signatures.slice(-2 * threshold);
  if (pairTail.length === 2 * threshold) {
    const [a, b] = pairTail;
    if (a !== b && pairTail.every((s, i) => s === (i % 2 === 0 ? a : b))) {
      return 'cycle';
    }
  }
  return null;
}
