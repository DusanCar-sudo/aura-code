import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowState,
  StepState,
  StepResult,
  StepStatus,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const WORKFLOW_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomBytes(4).toString('hex') + '-' + Date.now().toString(36);
}

/** Returns ~/.rubycode/workflows (or $RUBY_WORKFLOW_DIR if set). */
export function workflowsDir(): string {
  return process.env.RUBY_WORKFLOW_DIR
    ?? path.join(process.env.HOME ?? '/tmp', '.rubycode', 'workflows');
}

function workflowPath(id: string): string {
  return path.join(workflowsDir(), `${id}.json`);
}

/** Atomically write JSON to a file using a .tmp rename. */
async function writeJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tmp, filePath);
}

/** Read and parse a JSON file; returns null on any error. */
async function readJson<T>(filePath: string): Promise<T | null> {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Build the initial StepState array from a definition's steps. */
function buildInitialStepStates(steps: WorkflowStep[]): StepState[] {
  return steps.map(s => ({
    stepName: s.name,
    status: 'pending' as StepStatus,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

/** Callback the engine invokes to run a single step's task. */
export type RunStepFn = (
  task: string,
  stepIndex: number,
  previousResults: StepResult[],
) => Promise<StepResult>;

// ─────────────────────────────────────────────────────────────────────────────
// createWorkflow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new workflow definition and its initial state.
 * Persists the state to ~/.rubycode/workflows/<id>.json.
 * Returns the workflow state.
 */
export async function createWorkflow(opts: {
  name: string;
  description?: string;
  steps: WorkflowStep[];
}): Promise<WorkflowState> {
  const id = generateId();
  const now = Date.now();

  const definition: WorkflowDefinition = {
    id,
    name: opts.name,
    description: opts.description,
    steps: opts.steps,
    createdAt: now,
  };

  const state: WorkflowState = {
    definition,
    status: 'pending',
    stepStates: buildInitialStepStates(opts.steps),
    currentStep: -1,
  };

  await writeJson(workflowPath(id), { version: WORKFLOW_VERSION, state });
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// saveWorkflowState — persistence hook called after each step
// ─────────────────────────────────────────────────────────────────────────────

/** Persists the current workflow state to disk. */
export async function saveWorkflowState(state: WorkflowState): Promise<void> {
  await writeJson(workflowPath(state.definition.id), { version: WORKFLOW_VERSION, state });
}

// ─────────────────────────────────────────────────────────────────────────────
// loadWorkflowState
// ─────────────────────────────────────────────────────────────────────────────

/** Loads a workflow state from disk by ID. Returns null if not found. */
export async function loadWorkflowState(id: string): Promise<WorkflowState | null> {
  const raw = await readJson<{ version: number; state: WorkflowState }>(workflowPath(id));
  if (!raw || !raw.state) return null;
  return raw.state;
}

// ─────────────────────────────────────────────────────────────────────────────
// listWorkflows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lists all persisted workflows.
 * Returns an array of workflow states sorted by creation time (newest first).
 */
export async function listWorkflows(): Promise<WorkflowState[]> {
  const dir = workflowsDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const workflows: WorkflowState[] = [];

  for (const file of files) {
    const raw = await readJson<{ version: number; state: WorkflowState }>(
      path.join(dir, file),
    );
    if (raw && raw.state) {
      workflows.push(raw.state);
    }
  }

  return workflows.sort(
    (a, b) => (b.definition.createdAt) - (a.definition.createdAt),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// runWorkflow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a workflow from the beginning.
 * Runs steps sequentially, persisting state after each step completes.
 * Stops if a step fails.
 *
 * @param state   — the workflow state to execute (from createWorkflow)
 * @param runStep — callback that executes a single step's task
 * @returns the final workflow state
 */
export async function runWorkflow(
  state: WorkflowState,
  runStep: RunStepFn,
): Promise<WorkflowState> {
  state.status = 'running';
  state.startedAt = Date.now();
  state.currentStep = 0;
  await saveWorkflowState(state);

  const previousResults: StepResult[] = [];

  for (let i = 0; i < state.definition.steps.length; i++) {
    const step = state.definition.steps[i];
    const stepState = state.stepStates[i];

    // Mark step as running
    stepState.status = 'running';
    stepState.startedAt = Date.now();
    state.currentStep = i;
    await saveWorkflowState(state);

    try {
      const result = await runStep(step.task, i, previousResults);

      // Mark step as done
      stepState.status = 'done';
      stepState.result = result.summary;
      stepState.turns = result.turns;
      stepState.toolCallCount = result.toolCallCount;
      stepState.tokensUsed = result.tokensUsed;
      stepState.completedAt = Date.now();

      state.totalTokens = (state.totalTokens ?? 0) + result.tokensUsed;
      previousResults.push(result);

      await saveWorkflowState(state);
    } catch (err) {
      // Mark step as failed, pause workflow
      stepState.status = 'failed';
      stepState.error = err instanceof Error ? err.message : String(err);
      stepState.completedAt = Date.now();

      state.status = 'failed';
      state.completedAt = Date.now();
      state.outcome = `Workflow failed at step "${step.name}": ${stepState.error}`;
      await saveWorkflowState(state);
      return state;
    }
  }

  // All steps completed
  state.status = 'done';
  state.completedAt = Date.now();
  state.currentStep = state.definition.steps.length;
  state.outcome = `Workflow "${state.definition.name}" completed — ${state.definition.steps.length} steps`;
  await saveWorkflowState(state);

  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// resumeWorkflow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resumes a workflow from disk.
 * Finds the first non-done step and runs from there.
 * Steps with status 'done' are skipped (their results are passed to runStep).
 *
 * @param id      — the workflow ID to resume
 * @param runStep — callback that executes a single step's task
 * @returns the final workflow state, or null if the workflow was not found
 */
export async function resumeWorkflow(
  id: string,
  runStep: RunStepFn,
): Promise<WorkflowState | null> {
  const state = await loadWorkflowState(id);
  if (!state) return null;

  // Cannot resume a completed workflow
  if (state.status === 'done') {
    return state;
  }

  state.status = 'running';
  await saveWorkflowState(state);

  // Reconstruct previousResults from completed steps
  const previousResults: StepResult[] = state.stepStates
    .filter(ss => ss.status === 'done')
    .map(ss => ({
      success: true,
      summary: ss.result ?? '',
      turns: ss.turns ?? 0,
      toolCallCount: ss.toolCallCount ?? 0,
      tokensUsed: ss.tokensUsed ?? 0,
    }));

  // Find the first step that needs to run
  let startIndex = state.definition.steps.findIndex(
    (_, i) => state.stepStates[i].status !== 'done',
  );

  // If all steps are done (shouldn't happen since status isn't 'done'), just finish
  if (startIndex === -1) {
    state.status = 'done';
    state.completedAt = Date.now();
    state.outcome = `Workflow "${state.definition.name}" already completed`;
    await saveWorkflowState(state);
    return state;
  }

  // Reset a previously-failed step to pending so it retries
  if (state.stepStates[startIndex].status === 'failed') {
    state.stepStates[startIndex].status = 'pending';
    state.stepStates[startIndex].error = undefined;
    state.stepStates[startIndex].startedAt = undefined;
    state.stepStates[startIndex].completedAt = undefined;
  }

  state.startedAt = state.startedAt ?? Date.now();
  await saveWorkflowState(state);

  for (let i = startIndex; i < state.definition.steps.length; i++) {
    const step = state.definition.steps[i];
    const stepState = state.stepStates[i];

    // Mark step as running
    stepState.status = 'running';
    stepState.startedAt = Date.now();
    state.currentStep = i;
    await saveWorkflowState(state);

    try {
      const result = await runStep(step.task, i, previousResults);

      // Mark step as done
      stepState.status = 'done';
      stepState.result = result.summary;
      stepState.turns = result.turns;
      stepState.toolCallCount = result.toolCallCount;
      stepState.tokensUsed = result.tokensUsed;
      stepState.completedAt = Date.now();

      state.totalTokens = (state.totalTokens ?? 0) + result.tokensUsed;
      previousResults.push(result);

      await saveWorkflowState(state);
    } catch (err) {
      // Mark step as failed, pause workflow
      stepState.status = 'failed';
      stepState.error = err instanceof Error ? err.message : String(err);
      stepState.completedAt = Date.now();

      state.status = 'failed';
      state.completedAt = Date.now();
      state.outcome = `Workflow failed at step "${step.name}": ${stepState.error}`;
      await saveWorkflowState(state);
      return state;
    }
  }

  // All steps completed
  state.status = 'done';
  state.completedAt = Date.now();
  state.currentStep = state.definition.steps.length;
  state.outcome = `Workflow "${state.definition.name}" completed — ${state.definition.steps.length} steps`;
  await saveWorkflowState(state);

  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// deleteWorkflow
// ─────────────────────────────────────────────────────────────────────────────

/** Deletes a persisted workflow state file. Returns true if deleted. */
export async function deleteWorkflow(id: string): Promise<boolean> {
  const filePath = workflowPath(id);
  if (!fs.existsSync(filePath)) return false;
  await fs.promises.unlink(filePath);
  return true;
}
