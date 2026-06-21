// ─────────────────────────────────────────────────────────────────────────────
// Kanban Board Pipeline Types
// ─────────────────────────────────────────────────────────────────────────────

/** The five pipeline columns. */
export type PipelinePhase = 'read' | 'plan' | 'execute' | 'verify' | 'report';

/** The four swim-lane rows. */
export type PipelineRow = 'orchestrate' | 'architect' | 'verify' | 'ruby-alternator';

/** Status of a task card within the pipeline. */
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** A single task card on the board. */
export interface KanbanTask {
  /** Unique id. */
  id: string;
  /** Pipeline phase this task starts in. */
  phase: PipelinePhase;
  /** Swim-lane row. */
  row: PipelineRow;
  /** Badge / context label (e.g. "Agent: Researcher"). */
  badge: string;
  /** Human-readable title. */
  title: string;
  /** Detailed description. */
  description: string;
  /** Provider / runtime tag (e.g. "Claude-3.5", "Vitest"). */
  tag: string;
  /** Whether the card uses the high-priority (red) style. */
  highPriority: boolean;
}

/** Per-phase result for a single task. */
export interface PhaseResult {
  phase: PipelinePhase;
  status: TaskStatus;
  output: string;
  durationMs: number;
  error?: string;
}

/** Full pipeline execution record for one task. */
export interface TaskExecution {
  task: KanbanTask;
  phases: PhaseResult[];
  /** Overall status derived from phases. */
  status: TaskStatus;
  startedAt: number;
  completedAt?: number;
}

/** The report produced at the end of a pipeline run. */
export interface PipelineReport {
  /** ISO timestamp. */
  generatedAt: string;
  /** Wall-clock total. */
  totalDurationMs: number;
  /** Per-row execution records. */
  rows: RowReport[];
  /** Aggregate stats. */
  stats: {
    totalTasks: number;
    completed: number;
    failed: number;
    skipped: number;
  };
}

/** Report for one swim-lane row. */
export interface RowReport {
  row: PipelineRow;
  label: string;
  executions: TaskExecution[];
  status: TaskStatus;
}

/** Real-time progress event pushed over WebSocket. */
export interface ProgressEvent {
  type: 'phase_start' | 'phase_done' | 'row_done' | 'pipeline_done' | 'error';
  taskId?: string;
  phase?: PipelinePhase;
  row?: PipelineRow;
  status?: TaskStatus;
  output?: string;
  message?: string;
}
