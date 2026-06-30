// ─────────────────────────────────────────────────────────────────────────────
// Ruby Principle — core types
// ─────────────────────────────────────────────────────────────────────────────
//
// The Ruby Principle: two models alternate at exactly the moment where
// fine-tuning is needed. Ruby is a small local model (Qwen 1B/2B via Ollama)
// present from the beginning; it learns from every episode where a large
// model had to intervene.

// ─────────────────────────────────────────────────────────────────────────────
// Competence tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Learned competence for a recurring task pattern.
 * Built up over episodes where Ruby attempted the work before escalation.
 */
export interface CompetenceLevel {
  /** Normalised pattern key used to match future tasks (e.g. category + keywords). */
  taskPattern: string;
  /** Fraction of Ruby attempts that succeeded, in [0, 1]. */
  successRate: number;
  /** Total Ruby attempts recorded for this pattern. */
  attemptCount: number;
  /** Unix timestamp (ms) when this level was last updated. */
  lastUpdated: number;
  /** Recent exemplars that informed the success rate. */
  examples: { task: string; succeeded: boolean }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runtime configuration for the Ruby small-model alternation layer.
 * Typically loaded from `.aura/ruby.json` or CLI flags.
 */
export interface RubyConfig {
  /** Ollama model tag (e.g. `qwen2.5-coder:1.5b`). */
  modelName: string;
  /** OpenAI-compatible base URL for the local Ollama server. */
  ollamaBaseUrl: string;
  /**
   * Minimum success rate required before Ruby is trusted without escalation.
   * Compared against historical episodes for similar tasks.
   */
  competenceThreshold: number;
  /**
   * Minimum Ruby attempts on a pattern before competence gating applies.
   * Below this count, Ruby always gets a chance to gather training data.
   */
  minAttempts: number;
  /** When false, alternation always escalates to the large model. */
  enabled: boolean;
}

/** Sensible defaults for local Ollama + Qwen coder 1.5B. */
export const DEFAULT_RUBY_CONFIG: RubyConfig = {
  modelName: 'qwen2.5-coder:1.5b',
  ollamaBaseUrl: 'http://localhost:11434/v1',
  competenceThreshold: 0.7,
  minAttempts: 3,
  enabled: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Episodes — one alternation cycle
// ─────────────────────────────────────────────────────────────────────────────

/** Coarse task classification for competence reports and fine-tune bucketing. */
export type TaskCategory = 'research' | 'implementation' | 'review' | 'refactor' | 'other';

/**
 * A single alternation episode: Ruby tried (or was skipped), optionally escalated
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
  /** Whether Ruby (small model) was invoked for this episode. */
  rubyAttempted: boolean;
  /** Whether Ruby's output was accepted without large-model intervention. */
  rubySucceeded: boolean;
  /** Raw text produced by Ruby, if attempted. */
  rubyOutput?: string;
  /** Large-model id used when Ruby failed or was bypassed (e.g. `claude-sonnet-4-5`). */
  largeModelUsed?: string;
  /** Final output from the large model, if any. */
  largeModelOutput?: string;
  /** Whether a reviewer specialist approved the final result. */
  reviewerApproved: boolean;
  /** Token usage split by model tier. */
  tokensUsed: { ruby?: number; largeModel?: number };
  /** Wall-clock duration of the episode in milliseconds. */
  durationMs: number;
  /** Task category assigned by the router or orchestrator. */
  taskCategory: TaskCategory;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alternation decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Output of the alternator: whether to route this task to Ruby or escalate
 * immediately to the configured large model.
 */
export interface AlternationDecision {
  /** True when Ruby should handle the task; false when escalating. */
  useRuby: boolean;
  /** Human-readable explanation of the routing choice. */
  reason: string;
  /** Confidence in this decision, in [0, 1]. */
  confidence: number;
  /** Historical competence for the matched task pattern, if any. */
  competenceLevel?: CompetenceLevel;
  /** Large model to use when `useRuby` is false. */
  fallbackModel: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fine-tuning pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One instruction-tuning row derived from an episode where the large model
 * corrected or replaced Ruby's output.
 */
export interface TrainingExample {
  /** System or high-level directive for the small model. */
  instruction: string;
  /** Task context shown to the model. */
  input: string;
  /** Target output (typically from the large model after review). */
  output: string;
  metadata: {
    projectRoot: string;
    taskCategory: string;
    /** Why Ruby failed, when known — used to filter low-quality rows. */
    rubyFailureReason?: string;
    timestamp: number;
  };
}

/**
 * Tracks an asynchronous fine-tune job against the Ruby base model.
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