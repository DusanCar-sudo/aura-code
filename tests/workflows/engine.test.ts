import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createWorkflow,
  runWorkflow,
  resumeWorkflow,
  listWorkflows,
  loadWorkflowState,
  saveWorkflowState,
  deleteWorkflow,
  workflowsDir,
} from '../../src/workflows/engine.js';
import type { WorkflowState, StepResult, WorkflowStep } from '../../src/workflows/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeStepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    success: true,
    summary: 'Step completed successfully',
    turns: 3,
    toolCallCount: 5,
    tokensUsed: 1000,
    ...overrides,
  };
}

function makeSteps(n: number): WorkflowStep[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `step-${i + 1}`,
    task: `Do task ${i + 1}`,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Isolated temp directory for each test
// ─────────────────────────────────────────────────────────────────────────────
let homeTmp: string;

beforeEach(() => {
  homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-workflows-'));
  vi.stubEnv('HOME', homeTmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(homeTmp, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// workflowsDir
// ─────────────────────────────────────────────────────────────────────────────
describe('workflowsDir()', () => {
  it('returns ~/.rubycode/workflows by default', () => {
    expect(workflowsDir()).toBe(path.join(homeTmp, '.rubycode', 'workflows'));
  });

  it('respects RUBY_WORKFLOW_DIR env var', () => {
    vi.stubEnv('RUBY_WORKFLOW_DIR', '/custom/workflows');
    expect(workflowsDir()).toBe('/custom/workflows');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createWorkflow
// ─────────────────────────────────────────────────────────────────────────────
describe('createWorkflow()', () => {
  it('creates a workflow with correct id, name, and steps', async () => {
    const state = await createWorkflow({ name: 'Test WF', steps: makeSteps(3) });

    expect(state.definition.id).toBeTruthy();
    expect(state.definition.name).toBe('Test WF');
    expect(state.definition.steps).toHaveLength(3);
    expect(state.definition.createdAt).toBeGreaterThan(0);
    expect(state.status).toBe('pending');
    expect(state.currentStep).toBe(-1);
    expect(state.stepStates).toHaveLength(3);
    expect(state.stepStates.every(s => s.status === 'pending')).toBe(true);
  });

  it('persists the state to disk', async () => {
    const state = await createWorkflow({ name: 'Persist Test', steps: makeSteps(2) });
    const loaded = await loadWorkflowState(state.definition.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.definition.name).toBe('Persist Test');
    expect(loaded!.status).toBe('pending');
  });

  it('creates the workflows directory if it does not exist', async () => {
    const dir = workflowsDir();
    expect(fs.existsSync(dir)).toBe(false);

    await createWorkflow({ name: 'Dir Create', steps: makeSteps(1) });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('supports optional description', async () => {
    const state = await createWorkflow({
      name: 'With Desc',
      description: 'A workflow with a description',
      steps: makeSteps(1),
    });
    expect(state.definition.description).toBe('A workflow with a description');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runWorkflow
// ─────────────────────────────────────────────────────────────────────────────
describe('runWorkflow()', () => {
  it('runs all steps sequentially and marks workflow as done', async () => {
    const state = await createWorkflow({ name: 'Sequential', steps: makeSteps(3) });

    const executedSteps: number[] = [];
    const runStep = async (_task: string, stepIndex: number): Promise<StepResult> => {
      executedSteps.push(stepIndex);
      return makeStepResult();
    };

    const finalState = await runWorkflow(state, runStep);

    expect(finalState.status).toBe('done');
    expect(finalState.outcome).toContain('completed');
    expect(executedSteps).toEqual([0, 1, 2]);
    expect(finalState.stepStates.every(s => s.status === 'done')).toBe(true);
    expect(finalState.completedAt).toBeDefined();
  });

  it('persists state after each step', async () => {
    const state = await createWorkflow({ name: 'Persist Check', steps: makeSteps(2) });

    const persistenceSnapshots: string[] = [];

    const runStep = async (_task: string, stepIndex: number): Promise<StepResult> => {
      // Check persisted state before this step runs
      const loaded = await loadWorkflowState(state.definition.id);
      if (loaded) {
        persistenceSnapshots.push(
          `before-step-${stepIndex}:step${stepIndex}=${loaded.stepStates[stepIndex].status}`,
        );
      }
      return makeStepResult();
    };

    await runWorkflow(state, runStep);

    // The state file should exist with final result
    const final = await loadWorkflowState(state.definition.id);
    expect(final).not.toBeNull();
    expect(final!.status).toBe('done');

    // We should have seen 'running' for step 0 when the runStep was called
    expect(persistenceSnapshots).toHaveLength(2);
    expect(persistenceSnapshots[0]).toContain('before-step-0:step0=running');
  });

  it('passes previous step results to subsequent steps', async () => {
    const state = await createWorkflow({ name: 'Chaining', steps: makeSteps(3) });

    const receivedPrevious: StepResult[][] = [];

    const runStep = async (_task: string, _stepIndex: number, previousResults: StepResult[]): Promise<StepResult> => {
      receivedPrevious.push([...previousResults]);
      return makeStepResult({ summary: `Result for step ${_stepIndex}` });
    };

    await runWorkflow(state, runStep);

    // Step 0 gets no previous results
    expect(receivedPrevious[0]).toHaveLength(0);
    // Step 1 gets step 0's result
    expect(receivedPrevious[1]).toHaveLength(1);
    expect(receivedPrevious[1][0].summary).toBe('Result for step 0');
    // Step 2 gets steps 0+1's results
    expect(receivedPrevious[2]).toHaveLength(2);
  });

  it('stops on step failure and marks workflow as failed', async () => {
    const state = await createWorkflow({ name: 'Fail Test', steps: makeSteps(3) });

    let callCount = 0;
    const runStep = async (): Promise<StepResult> => {
      callCount++;
      if (callCount === 2) throw new Error('Step 2 exploded');
      return makeStepResult();
    };

    const finalState = await runWorkflow(state, runStep);

    expect(finalState.status).toBe('failed');
    expect(finalState.outcome).toContain('Step 2 exploded');
    expect(finalState.stepStates[0].status).toBe('done');
    expect(finalState.stepStates[1].status).toBe('failed');
    expect(finalState.stepStates[1].error).toBe('Step 2 exploded');
    expect(finalState.stepStates[2].status).toBe('pending'); // never reached
    expect(callCount).toBe(2);
  });

  it('tracks token usage across steps', async () => {
    const state = await createWorkflow({ name: 'Tokens', steps: makeSteps(2) });

    const runStep = async (_task: string, stepIndex: number): Promise<StepResult> => {
      return makeStepResult({ tokensUsed: (stepIndex + 1) * 500 });
    };

    const finalState = await runWorkflow(state, runStep);
    expect(finalState.totalTokens).toBe(1500); // 500 + 1000
  });

  it('records timing metadata for each step', async () => {
    const state = await createWorkflow({ name: 'Timing', steps: makeSteps(1) });

    const runStep = async (): Promise<StepResult> => {
      return makeStepResult();
    };

    const finalState = await runWorkflow(state, runStep);
    expect(finalState.stepStates[0].startedAt).toBeDefined();
    expect(finalState.stepStates[0].completedAt).toBeDefined();
    expect(finalState.stepStates[0].completedAt!).toBeGreaterThanOrEqual(
      finalState.stepStates[0].startedAt!,
    );
  });

  it('works with a single step', async () => {
    const state = await createWorkflow({ name: 'Single', steps: makeSteps(1) });

    const runStep = async (): Promise<StepResult> => makeStepResult();
    const finalState = await runWorkflow(state, runStep);

    expect(finalState.status).toBe('done');
    expect(finalState.stepStates).toHaveLength(1);
    expect(finalState.stepStates[0].status).toBe('done');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resumeWorkflow
// ─────────────────────────────────────────────────────────────────────────────
describe('resumeWorkflow()', () => {
  it('returns null for unknown workflow id', async () => {
    const result = await resumeWorkflow('does-not-exist', async () => makeStepResult());
    expect(result).toBeNull();
  });

  it('resumes a failed workflow from the failed step', async () => {
    const state = await createWorkflow({ name: 'Resume Test', steps: makeSteps(3) });

    // First run: fail at step 2 (index 1)
    let callCount = 0;
    const failStep = async (): Promise<StepResult> => {
      callCount++;
      if (callCount === 2) throw new Error('boom');
      return makeStepResult();
    };
    const failedState = await runWorkflow(state, failStep);
    expect(failedState.status).toBe('failed');
    expect(failedState.stepStates[1].status).toBe('failed');

    // Resume: all steps succeed
    const resumeResults: number[] = [];
    const successStep = async (_task: string, stepIndex: number): Promise<StepResult> => {
      resumeResults.push(stepIndex);
      return makeStepResult();
    };

    const resumedState = await resumeWorkflow(failedState.definition.id, successStep);
    expect(resumedState).not.toBeNull();
    expect(resumedState!.status).toBe('done');

    // Should have retried step 1 (the failed one) and then continued to step 2
    expect(resumeResults).toEqual([1, 2]);

    // Step 0 was already done — shouldn't be re-executed
    expect(resumedState!.stepStates[0].status).toBe('done');
    expect(resumedState!.stepStates[1].status).toBe('done');
    expect(resumedState!.stepStates[2].status).toBe('done');
  });

  it('returns the same state if workflow is already done', async () => {
    const state = await createWorkflow({ name: 'Already Done', steps: makeSteps(1) });
    const runStep = async (): Promise<StepResult> => makeStepResult();
    const doneState = await runWorkflow(state, runStep);

    let called = false;
    const resumeResult = await resumeWorkflow(doneState.definition.id, async () => {
      called = true;
      return makeStepResult();
    });

    expect(resumeResult).not.toBeNull();
    expect(resumeResult!.status).toBe('done');
    expect(called).toBe(false); // should not re-execute any steps
  });

  it('passes results from completed steps to resumed runStep', async () => {
    const state = await createWorkflow({ name: 'Context Pass', steps: makeSteps(3) });

    // Fail at step 3
    let count = 0;
    const failAtEnd = async (): Promise<StepResult> => {
      count++;
      if (count === 3) throw new Error('step 3 failed');
      return makeStepResult({ summary: `done-${count}` });
    };
    const failedState = await runWorkflow(state, failAtEnd);

    // Resume
    let receivedPrev: StepResult[] = [];
    const resumeStep = async (_task: string, _stepIndex: number, prev: StepResult[]): Promise<StepResult> => {
      receivedPrev = [...prev];
      return makeStepResult();
    };

    await resumeWorkflow(failedState.definition.id, resumeStep);

    // Step 2 (index 2) was the failed step; it should get 2 previous results (step 0 + step 1)
    expect(receivedPrev).toHaveLength(2);
    expect(receivedPrev[0].summary).toBe('done-1');
    expect(receivedPrev[1].summary).toBe('done-2');
  });

  it('fails again if resumed step also fails', async () => {
    const state = await createWorkflow({ name: 'Double Fail', steps: makeSteps(2) });

    // First run: fail at step 1
    const runStep = async (): Promise<StepResult> => {
      throw new Error('always fails');
    };
    const failedState = await runWorkflow(state, runStep);
    expect(failedState.status).toBe('failed');

    // Resume: still fails
    const resumedState = await resumeWorkflow(failedState.definition.id, runStep);
    expect(resumedState).not.toBeNull();
    expect(resumedState!.status).toBe('failed');
    expect(resumedState!.stepStates[0].status).toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listWorkflows
// ─────────────────────────────────────────────────────────────────────────────
describe('listWorkflows()', () => {
  it('returns empty array when no workflows exist', async () => {
    const list = await listWorkflows();
    expect(list).toEqual([]);
  });

  it('returns all saved workflows', async () => {
    await createWorkflow({ name: 'WF 1', steps: makeSteps(1) });
    await createWorkflow({ name: 'WF 2', steps: makeSteps(2) });

    const list = await listWorkflows();
    expect(list).toHaveLength(2);
    expect(list.map(w => w.definition.name).sort()).toEqual(['WF 1', 'WF 2']);
  });

  it('returns workflows sorted by creation time (newest first)', async () => {
    const first = await createWorkflow({ name: 'Old', steps: makeSteps(1) });
    // Ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    const second = await createWorkflow({ name: 'New', steps: makeSteps(1) });

    const list = await listWorkflows();
    expect(list[0].definition.name).toBe('New');
    expect(list[1].definition.name).toBe('Old');
  });

  it('skips corrupt JSON files gracefully', async () => {
    await createWorkflow({ name: 'Valid', steps: makeSteps(1) });
    // Write a corrupt file
    fs.writeFileSync(path.join(workflowsDir(), 'corrupt.json'), 'not json');

    const list = await listWorkflows();
    expect(list).toHaveLength(1);
    expect(list[0].definition.name).toBe('Valid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// saveWorkflowState / loadWorkflowState
// ─────────────────────────────────────────────────────────────────────────────
describe('saveWorkflowState / loadWorkflowState', () => {
  it('round-trips correctly', async () => {
    const state = await createWorkflow({ name: 'Round Trip', steps: makeSteps(2) });
    state.status = 'running';
    state.currentStep = 0;
    state.startedAt = Date.now();
    await saveWorkflowState(state);

    const loaded = await loadWorkflowState(state.definition.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('running');
    expect(loaded!.currentStep).toBe(0);
    expect(loaded!.startedAt).toBe(state.startedAt);
  });

  it('returns null for non-existent workflow', async () => {
    const loaded = await loadWorkflowState('no-such-id');
    expect(loaded).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteWorkflow
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteWorkflow()', () => {
  it('deletes a persisted workflow', async () => {
    const state = await createWorkflow({ name: 'To Delete', steps: makeSteps(1) });
    expect(fs.existsSync(path.join(workflowsDir(), `${state.definition.id}.json`))).toBe(true);

    const deleted = await deleteWorkflow(state.definition.id);
    expect(deleted).toBe(true);
    expect(fs.existsSync(path.join(workflowsDir(), `${state.definition.id}.json`))).toBe(false);
  });

  it('returns false for non-existent workflow', async () => {
    const deleted = await deleteWorkflow('does-not-exist');
    expect(deleted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────
describe('edge cases', () => {
  it('handles zero steps gracefully', async () => {
    const state = await createWorkflow({ name: 'Empty', steps: [] });
    expect(state.status).toBe('pending');
    expect(state.stepStates).toHaveLength(0);

    const runStep = async (): Promise<StepResult> => makeStepResult();
    const finalState = await runWorkflow(state, runStep);
    expect(finalState.status).toBe('done');
    expect(finalState.outcome).toContain('0 steps');
  });

  it('handles non-Error throws in runStep', async () => {
    const state = await createWorkflow({ name: 'String Throw', steps: makeSteps(1) });

    const runStep = async (): Promise<StepResult> => {
      throw 'string error'; // eslint-disable-line no-throw-literal
    };

    const finalState = await runWorkflow(state, runStep);
    expect(finalState.status).toBe('failed');
    expect(finalState.stepStates[0].error).toBe('string error');
  });

  it('workflow id format is valid', async () => {
    const state = await createWorkflow({ name: 'ID Check', steps: makeSteps(1) });
    // Should be hex-timestamp format
    expect(state.definition.id).toMatch(/^[a-f0-9]+-[a-z0-9]+$/);
  });
});
