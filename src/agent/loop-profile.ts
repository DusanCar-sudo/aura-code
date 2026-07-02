/**
 * Task classification for turn-budget sizing.
 *
 * Cheap heuristics only — no LLM call. Spending a model turn to decide
 * how many turns to allow defeats the purpose. This is pattern matching
 * on the task string, nothing more.
 */

export type TaskShape = 'single-file' | 'multi-file' | 'exploratory';

export interface LoopProfile {
  maxTurns: number;
  shape: TaskShape;
  /** How many identical consecutive turn-signatures count as a stall. */
  stallThreshold: number;
  /**
   * One-time budget upgrade: if the run hits maxTurns while still making
   * progress (not stalled), widen once to this ceiling instead of ending
   * with a resume hint. Absent for shapes already at the top tier and
   * whenever the user passed an explicit --max-turns (a hard ceiling).
   */
  widenTo?: number;
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

const PROFILES: Record<TaskShape, Omit<LoopProfile, 'shape'>> = {
  'single-file':  { maxTurns: 30,  stallThreshold: 3, widenTo: 80 },
  'multi-file':   { maxTurns: 150, stallThreshold: 4 },
  'exploratory':  { maxTurns: 80,  stallThreshold: 4 },
};

/**
 * Get the loop profile for a task.
 *
 * @param task     The task prompt.
 * @param override Explicit maxTurns from CLI flag or config — always wins,
 *                 and is a hard ceiling (no adaptive widening past it).
 */
export function getLoopProfile(task: string, override?: number): LoopProfile {
  const shape = classifyTask(task);
  const base = PROFILES[shape];

  if (override !== undefined) {
    return { shape, maxTurns: override, stallThreshold: base.stallThreshold };
  }
  return {
    shape,
    maxTurns: base.maxTurns,
    stallThreshold: base.stallThreshold,
    widenTo: base.widenTo,
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
