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
  'single-file':  { maxTurns: 30,  stallThreshold: 3 },
  'multi-file':   { maxTurns: 150, stallThreshold: 4 },
  'exploratory':  { maxTurns: 80,  stallThreshold: 4 },
};

/**
 * Get the loop profile for a task.
 *
 * @param task     The task prompt.
 * @param override Explicit maxTurns from CLI flag or config — always wins.
 */
export function getLoopProfile(task: string, override?: number): LoopProfile {
  const shape = classifyTask(task);
  const base = PROFILES[shape];

  return {
    shape,
    maxTurns: override ?? base.maxTurns,
    stallThreshold: base.stallThreshold,
  };
}
