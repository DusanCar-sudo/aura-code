// ─────────────────────────────────────────────────────────────────────────────
// Workflow types — persistent sequential workflow engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single named task within a workflow.
 * Steps are executed sequentially in the order they appear in the definition.
 */
export interface WorkflowStep {
  /** Human-readable name for this step (unique within the workflow). */
  name: string;
  /** The task prompt sent to the agent loop for this step. */
  task: string;
}

/**
 * Static definition of a workflow — the blueprint before execution.
 */
export interface WorkflowDefinition {
  /** Unique identifier for this workflow (generated on creation). */
  id: string;
  /** Human-readable workflow name. */
  name: string;
  /** Optional description of what this workflow accomplishes. */
  description?: string;
  /** Ordered list of steps to execute sequentially. */
  steps: WorkflowStep[];
  /** Unix timestamp (ms) when this workflow was created. */
  createdAt: number;
}

/**
 * Lifecycle state of a single step within a running workflow.
 */
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/**
 * Runtime state of a workflow — persisted to disk after each step completes.
 * Used for resume: the engine reads this to know which step to pick up from.
 */
export interface WorkflowState {
  /** The full workflow definition (copied into state for self-contained files). */
  definition: WorkflowDefinition;
  /**
   * Lifecycle state of the overall workflow.
   * - `pending`  — created but not yet started
   * - `running`  — at least one step is executing
   * - `paused`   — user or system paused; can be resumed
   * - `done`     — all steps completed successfully
   * - `failed`   — a step failed and execution halted
   */
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed';
  /**
   * Per-step status tracking, indexed in the same order as definition.steps.
   * Each entry includes the step result (summary) and timing metadata.
   */
  stepStates: StepState[];
  /** Index of the step currently running or next to run (0-based). -1 if not started. */
  currentStep: number;
  /** Unix timestamp (ms) when workflow execution began. */
  startedAt?: number;
  /** Unix timestamp (ms) when workflow reached a terminal state. */
  completedAt?: number;
  /** Total number of tokens consumed across all completed steps. */
  totalTokens?: number;
  /** Overall result summary (set when status is 'done' or 'failed'). */
  outcome?: string;
}

/** Result of a single step execution (returned by the runStep callback). */
export interface StepResult {
  success: boolean;
  summary: string;
  turns: number;
  toolCallCount: number;
  tokensUsed: number;
}

/**
 * Runtime state of a single step within a workflow.
 */
export interface StepState {
  /** Name of the step (matches WorkflowStep.name). */
  stepName: string;
  /** Current lifecycle status of this step. */
  status: StepStatus;
  /** Result summary produced by the agent loop, if completed. */
  result?: string;
  /** Number of turns the agent loop took for this step. */
  turns?: number;
  /** Number of tool calls the agent loop made for this step. */
  toolCallCount?: number;
  /** Tokens consumed by this step. */
  tokensUsed?: number;
  /** Error message if status is 'failed'. */
  error?: string;
  /** Unix timestamp (ms) when this step started executing. */
  startedAt?: number;
  /** Unix timestamp (ms) when this step finished (done/failed). */
  completedAt?: number;
}
