import { describe, it, expect } from 'vitest';
import type {
  PlanStep,
  ExecutionPlan,
  RouterDecision,
} from '../../src/orchestration/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Contract constants (mirror types.ts unions)
// ─────────────────────────────────────────────────────────────────────────────
const SPECIALISTS = ['researcher', 'coder', 'reviewer', 'planner'] as const;
const PLAN_STEP_STATUSES = ['waiting', 'running', 'done', 'failed', 'skipped'] as const;
const EXECUTION_PLAN_STATUSES = ['pending', 'running', 'done', 'failed', 'aborted'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Validators — document the shape contracts tests enforce
// ─────────────────────────────────────────────────────────────────────────────
function assertValidPlanStep(step: PlanStep): void {
  expect(typeof step.id).toBe('string');
  expect(step.id.length).toBeGreaterThan(0);
  expect(SPECIALISTS).toContain(step.specialist);
  expect(typeof step.task).toBe('string');
  expect(typeof step.context).toBe('string');
  expect(Array.isArray(step.dependsOn)).toBe(true);
  expect(PLAN_STEP_STATUSES).toContain(step.status);
  if (step.result !== undefined) expect(typeof step.result).toBe('string');
  if (step.tokensUsed !== undefined) expect(typeof step.tokensUsed).toBe('number');
  if (step.durationMs !== undefined) expect(typeof step.durationMs).toBe('number');
}

function assertValidExecutionPlan(plan: ExecutionPlan): void {
  expect(typeof plan.id).toBe('string');
  expect(plan.id.length).toBeGreaterThan(0);
  expect(typeof plan.goal).toBe('string');
  expect(Array.isArray(plan.steps)).toBe(true);
  plan.steps.forEach(assertValidPlanStep);
  expect(EXECUTION_PLAN_STATUSES).toContain(plan.status);
  expect(typeof plan.created).toBe('number');
  if (plan.completed !== undefined) expect(typeof plan.completed).toBe('number');
  if (plan.totalTokens !== undefined) expect(typeof plan.totalTokens).toBe('number');
  if (plan.outcome !== undefined) expect(typeof plan.outcome).toBe('string');
}

function assertValidRouterDecision(decision: RouterDecision): void {
  expect(typeof decision.shouldDecompose).toBe('boolean');
  expect(typeof decision.reason).toBe('string');
  expect(decision.confidence).toBeGreaterThanOrEqual(0);
  expect(decision.confidence).toBeLessThanOrEqual(1);
  if (decision.estimatedSteps !== undefined) {
    expect(typeof decision.estimatedSteps).toBe('number');
    expect(decision.estimatedSteps).toBeGreaterThan(0);
  }
}

function makePlanStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 'step-1',
    specialist: 'coder',
    task: 'Implement the feature',
    context: '',
    dependsOn: [],
    status: 'waiting',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PlanStep
// ─────────────────────────────────────────────────────────────────────────────
describe('PlanStep', () => {
  it('minimal step has expected defaults (empty context, no deps, waiting)', () => {
    const step = makePlanStep();
    expect(step.context).toBe('');
    expect(step.dependsOn).toEqual([]);
    expect(step.status).toBe('waiting');
    expect(step.result).toBeUndefined();
    expect(step.tokensUsed).toBeUndefined();
    expect(step.durationMs).toBeUndefined();
    assertValidPlanStep(step);
  });

  it('requires id, specialist, task, context, dependsOn, and status', () => {
    const step = makePlanStep({
      id: 'required-fields',
      specialist: 'reviewer',
      task: 'Review changes',
      context: 'Focus on safety',
      dependsOn: ['step-0'],
      status: 'running',
    });
    assertValidPlanStep(step);
    expect(step.id).toBe('required-fields');
    expect(step.specialist).toBe('reviewer');
    expect(step.task).toBe('Review changes');
    expect(step.context).toBe('Focus on safety');
    expect(step.dependsOn).toEqual(['step-0']);
    expect(step.status).toBe('running');
  });

  it('accepts every valid specialist and step status', () => {
    for (const specialist of SPECIALISTS) {
      for (const status of PLAN_STEP_STATUSES) {
        assertValidPlanStep(makePlanStep({ specialist, status }));
      }
    }
  });

  it('rejects invalid step status strings', () => {
    const bad = makePlanStep({ status: 'paused' as PlanStep['status'] });
    expect(PLAN_STEP_STATUSES).not.toContain(bad.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ExecutionPlan
// ─────────────────────────────────────────────────────────────────────────────
describe('ExecutionPlan', () => {
  it('accepts every valid plan status', () => {
    for (const status of EXECUTION_PLAN_STATUSES) {
      const plan: ExecutionPlan = {
        id: `plan-${status}`,
        goal: 'Test goal',
        steps: [makePlanStep()],
        status,
        created: Date.now(),
      };
      assertValidExecutionPlan(plan);
      expect(plan.status).toBe(status);
    }
  });

  it('models typical status transitions as valid status strings', () => {
    const transitions: Array<[ExecutionPlan['status'], ExecutionPlan['status']]> = [
      ['pending', 'running'],
      ['running', 'done'],
      ['running', 'failed'],
      ['pending', 'aborted'],
      ['running', 'aborted'],
    ];
    for (const [from, to] of transitions) {
      expect(EXECUTION_PLAN_STATUSES).toContain(from);
      expect(EXECUTION_PLAN_STATUSES).toContain(to);
    }
  });

  it('rejects invalid plan status strings', () => {
    const invalid = 'cancelled' as ExecutionPlan['status'];
    expect(EXECUTION_PLAN_STATUSES).not.toContain(invalid);
  });

  it('validates a complete plan with optional terminal fields', () => {
    const plan: ExecutionPlan = {
      id: 'full-plan',
      goal: 'Ship orchestration',
      steps: [
        makePlanStep({ id: 's1', status: 'done', result: 'ok', tokensUsed: 10, durationMs: 50 }),
      ],
      status: 'done',
      created: 1_000,
      completed: 2_000,
      totalTokens: 10,
      outcome: 'All steps completed',
    };
    assertValidExecutionPlan(plan);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RouterDecision
// ─────────────────────────────────────────────────────────────────────────────
describe('RouterDecision', () => {
  it('accepts confidence at the boundaries 0 and 1', () => {
    assertValidRouterDecision({
      shouldDecompose: false,
      reason: 'Simple task',
      confidence: 0,
    });
    assertValidRouterDecision({
      shouldDecompose: true,
      reason: 'Complex task',
      confidence: 1,
      estimatedSteps: 3,
    });
  });

  it('accepts fractional confidence within [0, 1]', () => {
    assertValidRouterDecision({
      shouldDecompose: true,
      reason: 'Moderate complexity',
      confidence: 0.75,
    });
  });

  it('flags confidence below 0 as out of range', () => {
    const decision: RouterDecision = {
      shouldDecompose: false,
      reason: 'Bad input',
      confidence: -0.1,
    };
    expect(decision.confidence).toBeLessThan(0);
    expect(() => assertValidRouterDecision(decision)).toThrow();
  });

  it('flags confidence above 1 as out of range', () => {
    const decision: RouterDecision = {
      shouldDecompose: true,
      reason: 'Overconfident',
      confidence: 1.5,
    };
    expect(decision.confidence).toBeGreaterThan(1);
    expect(() => assertValidRouterDecision(decision)).toThrow();
  });
});