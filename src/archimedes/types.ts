// ─────────────────────────────────────────────────────────────────────────────
// Archimedes Principle — core types
// ─────────────────────────────────────────────────────────────────────────────
//
// The Archimedes Principle: two models alternate at exactly the moment where
// fine-tuning is needed. Archimedes is a small local model (Qwen 1B/2B via Ollama)
// present from the beginning; it learns from every episode where a large
// model had to intervene.

// ─────────────────────────────────────────────────────────────────────────────
// Competence tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Learned competence for a recurring task pattern.
 * Built up over episodes where Archimedes attempted the work before escalation.
 */
export interface CompetenceLevel {
  /** Normalised pattern key used to match future tasks (e.g. category + keywords). */
  taskPattern: string;
  /** Fraction of Archimedes attempts that succeeded, in [0, 1]. */
  successRate: number;
  /** Total Archimedes attempts recorded for this pattern. */
  attemptCount: number;
  /** Unix timestamp (ms) when this level was last updated. */
  lastUpdated: number;
  /** Recent exemplars that informed the success rate. */
  examples: { task: string; succeeded: boolean }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Which local model server Archimedes talks to. */
export type ArchimedesBackend = 'ollama' | 'lmstudio';

/**
 * Runtime configuration for the Archimedes small-model alternation layer.
 * Typically loaded from `.aura/archimedes.json` or CLI flags.
 */
export interface ArchimedesConfig {
  /**
   * Local model id — an Ollama tag (`qwen2.5-coder:1.5b`) or an LM Studio id
   * (`qwen/qwen3-1.7b`). May carry an `ollama/` or `lmstudio/` routing prefix,
   * which selects the backend and is stripped before the request goes out.
   */
  modelName: string;
  /** OpenAI-compatible base URL for the local Ollama server. */
  ollamaBaseUrl: string;
  /**
   * Which local server to use. Omitted = inferred from a `modelName` prefix,
   * falling back to Ollama for configs written before LM Studio was supported.
   */
  backend?: ArchimedesBackend;
  /** OpenAI-compatible base URL for the local LM Studio server. */
  lmstudioBaseUrl?: string;
  /**
   * Minimum success rate required before Archimedes is trusted without escalation.
   * Compared against historical episodes for similar tasks.
   */
  competenceThreshold: number;
  /**
   * Minimum Archimedes attempts on a pattern before competence gating applies.
   * Below this count, Archimedes always gets a chance to gather training data.
   */
  minAttempts: number;
  /** When false, alternation always escalates to the large model. */
  enabled: boolean;
  /**
   * Probability, in [0, 1], of letting Archimedes attempt a task whose pattern
   * is gated (success rate below `competenceThreshold`). Keeps the competence
   * score live for gated patterns — without it a gate would freeze permanently,
   * since scores only move on actual attempts.
   */
  epsilonProbeRate: number;
  /**
   * Model that verifies answers, when it should not be the model that wrote
   * them. Omitted (the default) keeps the long-standing behaviour: the large
   * model verifies, including on the escalation and council paths where it is
   * grading its own output — the model marks its own homework.
   *
   * Set this to any routing id (`claude-sonnet-5`, `deepseek/deepseek-v4-pro`,
   * `ollama/…`) to hand verification to a different provider. Whether that
   * changes the missed-escalation rate is the measurement of self-grading bias
   * — see benchmark/escalation.
   */
  verifierModel?: string;
}

/** Sensible defaults for local Ollama + Qwen coder 1.5B. */
export const DEFAULT_ARCHIMEDES_CONFIG: ArchimedesConfig = {
  modelName: 'qwen2.5-coder:1.5b',
  ollamaBaseUrl: 'http://localhost:11434/v1',
  lmstudioBaseUrl: 'http://localhost:1234/v1',
  competenceThreshold: 0.7,
  minAttempts: 3,
  enabled: true,
  epsilonProbeRate: 0.05,
};

// ─────────────────────────────────────────────────────────────────────────────
// Episodes — one alternation cycle
// ─────────────────────────────────────────────────────────────────────────────

/** Coarse task classification for competence reports and fine-tune bucketing. */
export type TaskCategory = 'research' | 'implementation' | 'review' | 'refactor' | 'other';

/**
 * A single alternation episode: Archimedes tried (or was skipped), optionally escalated
 * to a large model, then reviewed.
 */
export interface Episode {
  /** Unique episode identifier. */
  id: string;
  /** Unix timestamp (ms) when the episode completed. */
  timestamp: number;
  /** Original user task text. */
  task: string;
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Whether Archimedes (small model) was invoked for this episode. */
  archimedesAttempted: boolean;
  /** Whether Archimedes's output was accepted without large-model intervention. */
  archimedesSucceeded: boolean;
  /** Raw text produced by Archimedes, if attempted. */
  archimedesOutput?: string;
  /** Large-model id used when Archimedes failed or was bypassed (e.g. `claude-sonnet-4-5`). */
  largeModelUsed?: string;
  /** Final output from the large model, if any. */
  largeModelOutput?: string;
  /** Whether a reviewer specialist approved the final result. */
  reviewerApproved: boolean;
  /** Token usage split by model tier. */
  tokensUsed: { archimedes?: number; largeModel?: number };
  /** Wall-clock duration of the episode in milliseconds. */
  durationMs: number;
  /** Task category assigned by the router or orchestrator. */
  taskCategory: TaskCategory;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alternation decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Output of the alternator: whether to route this task to Archimedes or escalate
 * immediately to the configured large model.
 */
export interface AlternationDecision {
  /** True when Archimedes should handle the task; false when escalating. */
  useArchimedes: boolean;
  /** Human-readable explanation of the routing choice. */
  reason: string;
  /** Confidence in this decision, in [0, 1]. */
  confidence: number;
  /** Historical competence for the matched task pattern, if any. */
  competenceLevel?: CompetenceLevel;
  /** Large model to use when `useArchimedes` is false. */
  fallbackModel: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fine-tuning pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One instruction-tuning row derived from the Archimedes alternation loop.
 *
 * Two provenances exist (see src/mining/):
 *   - 'mined'      — a generalized lesson written by Papa Archimedes (local model)
 *                    from statistical clusters (Path A, existing mining path).
 *   - 'correction' — a direct correction pair: the exact task, the context the
 *                    small model saw, and the accepted large-model output
 *                    (Path B, from escalation episodes where Archimedes failed).
 * The tag survives into the jsonl so the two sources can be ablated separately.
 */
export interface TrainingExample {
  /** System or high-level directive for the small model. */
  instruction: string;
  /** Task context shown to the model. */
  input: string;
  /** Target output — the accepted answer. For 'correction' rows this is the
   * large model's output after review; for 'mined' rows it is the local
   * model's generalized lesson. */
  output: string;
  metadata: {
    projectRoot: string;
    taskCategory: string;
    /** Which pipeline produced this row. Survives into the jsonl. */
    provenance: 'mined' | 'correction';
    /** Why Archimedes failed, when known — used to filter low-quality rows. */
    archimedesFailureReason?: string;
    timestamp: number;
  };
}

/**
 * Tracks an asynchronous fine-tune job against the Archimedes base model.
 */
export interface FineTuneJob {
  /** Unique job identifier. */
  id: string;
  /** Job lifecycle state. */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Base Ollama model before fine-tuning. */
  baseModel: string;
  /** Number of training examples submitted. */
  trainingExamples: number;
  /** Resulting model tag after a successful run. */
  outputModel: string;
  /** Unix timestamp (ms) when the job started. */
  startedAt?: number;
  /** Unix timestamp (ms) when the job reached a terminal state. */
  completedAt?: number;
  /** Error message when `status` is `failed`. */
  error?: string;
}