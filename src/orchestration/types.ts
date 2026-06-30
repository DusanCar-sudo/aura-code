// ─────────────────────────────────────────────────────────────────────────────
// Execution plan steps
// ─────────────────────────────────────────────────────────────────────────────

/** A single unit of work assigned to one specialist agent. */
export interface PlanStep {
  /** Stable unique identifier for this step within the plan. */
  id: string;
  /**
   * Which specialist role executes this step.
   * - `researcher` — gathers context, reads files, queries perception graph
   * - `coder`      — writes or modifies source files
   * - `reviewer`   — validates correctness, style, and constraints
   * - `planner`    — decomposes sub-goals when the original plan needs revision
   */
  specialist: 'researcher' | 'coder' | 'reviewer' | 'planner';
  /** Human-readable description of what this step must accomplish. */
  task: string;
  /** Relevant background injected into the specialist's system prompt. */
  context: string;
  /** ids of steps that must reach `done` before this step may start. */
  dependsOn: string[];
  /** Output produced by the specialist once the step finishes. */
  result?: string;
  /**
   * Lifecycle state of this step.
   * - `waiting`  — blocked on `dependsOn`
   * - `running`  — currently executing
   * - `done`     — completed successfully
   * - `failed`   — terminated with an error
   * - `skipped`  — bypassed because a dependency failed
   */
  status: 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
  /** Total tokens consumed by the specialist during this step. */
  tokensUsed?: number;
  /** Wall-clock time the step took to complete, in milliseconds. */
  durationMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution plan
// ─────────────────────────────────────────────────────────────────────────────

/** A decomposed, ordered work plan produced by the orchestrator for a goal. */
export interface ExecutionPlan {
  /** Unique identifier for this plan (used as the on-disk filename). */
  id: string;
  /** The original user goal that triggered plan creation. */
  goal: string;
  /** Ordered list of steps; may be executed concurrently where deps allow. */
  steps: PlanStep[];
  /**
   * Lifecycle state of the overall plan.
   * - `pending`  — created but not yet started
   * - `running`  — at least one step is executing
   * - `done`     — all steps reached `done`
   * - `failed`   — a step failed and execution halted
   * - `aborted`  — cancelled by the user or a safety guard
   */
  status: 'pending' | 'running' | 'done' | 'failed' | 'aborted';
  /** Unix timestamp (ms) when this plan was created. */
  created: number;
  /** Unix timestamp (ms) when the plan reached a terminal state. */
  completed?: number;
  /** Aggregate token count across all steps. */
  totalTokens?: number;
  /** Final summary written by the orchestrator after all steps finish. */
  outcome?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration memory
// ─────────────────────────────────────────────────────────────────────────────

/** A single key-value fact persisted to the project's orchestration memory. */
export interface OrchestrationMemory {
  /** Logical key used to retrieve this entry later (e.g. "auth_strategy"). */
  key: string;
  /** The remembered value — free-form string, may be serialised JSON. */
  value: string;
  /** id of the PlanStep that wrote this entry. */
  stepId: string;
  /** Unix timestamp (ms) when this entry was written. */
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Router decision
// ─────────────────────────────────────────────────────────────────────────────

/** Output of the orchestrator's routing pass for an incoming goal. */
export interface RouterDecision {
  /** Whether the goal should be decomposed into a multi-step plan. */
  shouldDecompose: boolean;
  /** Explanation of why the router reached this decision. */
  reason: string;
  /** Router's confidence in the decision, in [0, 1]. */
  confidence: number;
  /** Rough number of steps the router expects the plan will contain. */
  estimatedSteps?: number;
}
