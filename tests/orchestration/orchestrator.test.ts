import { describe, it, expect, vi } from 'vitest';
import { createPlan } from '../../src/orchestration/orchestrator.js';
import { ORCHESTRATOR_SYSTEM_PROMPT } from '../../src/orchestration/orchestrator-prompts.js';
import type {
  ExecutionPlan,
  PlanStep,
  OrchestrationMemory,
} from '../../src/orchestration/types.js';
import type {
  LLMProvider,
  LLMResponse,
  HistoryMessage,
  ToolDefinition,
  StreamChunk,
} from '../../src/providers/types.js';
import type { ProjectContext } from '../../src/agent/context.js';
import type { ProjectPerception } from '../../src/perception/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Reusable mock LLMProvider — identical pattern to router.test.ts
// ─────────────────────────────────────────────────────────────────────────────
class MockProvider implements LLMProvider {
  name = 'MockOrchestrator';
  model = 'mock-orch-model';
  supportsTools = false;

  private responses: LLMResponse[];
  public calls: HistoryMessage[] = [];

  constructor(responses: LLMResponse[]) {
    this.responses = [...responses];
  }

  async complete(
    _system: string,
    history: HistoryMessage[],
    _tools: ToolDefinition[],
  ): Promise<LLMResponse> {
    this.calls.push(...history);
    const next = this.responses.shift();
    if (!next) throw new Error('[MockOrchestrator] No more responses queued');
    return next;
  }

  async *stream(
    _system: string,
    history: HistoryMessage[],
    _tools: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    this.calls.push(...history);
    const next = this.responses.shift();
    if (!next) throw new Error('[MockOrchestrator] No more responses queued');
    if (next.text) yield { type: 'text', text: next.text };
    yield { type: 'done', response: next };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const mockContext: ProjectContext = {
  root: '/fake/project',
  name: 'aura-code',
  language: 'TypeScript',
  framework: 'Node.js',
  readme: '# Aura\n\nModel-agnostic AI coding agent.',
  tree: 'src/\n  agent/\n  providers/\n  orchestration/',
  config: '{\n  "name": "aura-code",\n  "version": "0.1.0"\n}',
  recentCommits: 'abc1234 Add orchestration layer',
};

const mockPerception: ProjectPerception = {
  projectRoot: '/fake/project',
  nodes: [
    {
      id: 'core/auth',
      type: 'module',
      label: 'Auth module',
      description: 'Handles authentication and authorization',
      metadata: { riskArea: 'security-critical' },
    },
    {
      id: 'src/api',
      type: 'module',
      label: 'API layer',
      description: 'REST API endpoints',
      metadata: {},
    },
    {
      id: 'src/db',
      type: 'module',
      label: 'Database layer',
      description: 'Database access and migrations',
      metadata: { riskArea: 'legacy-refactor' },
    },
  ],
  edges: [],
  trajectory: {
    vision: 'Build a secure platform',
    deprecated: [],
    inProgress: [],
    planned: [],
  },
  constraints: {
    readOnly: ['package-lock.json'],
    strictRules: ['No circular deps in core/'],
    riskAreas: ['security-critical', 'legacy-refactor'],
    testCoverage: [
      { module: 'core', coverage: 'high' },
      { module: 'src', coverage: 'medium' },
    ],
  },
  extractedAt: Date.now(),
  version: '1.0.0',
};

// ─────────────────────────────────────────────────────────────────────────────
// Response factories — controlled plan JSON the mock model returns
// ─────────────────────────────────────────────────────────────────────────────

/** A valid 3-step researcher → coder → reviewer plan. */
function threeStepPlanJSON(overrides: {
  goal?: string;
  stepOverrides?: Partial<PlanStep>[];
} = {}): string {
  const goal = overrides.goal ?? 'Add rate limiting middleware to the Express API.';
  const baseSteps = [
    {
      id: 'step-1',
      specialist: 'researcher' as const,
      task: 'Read src/server/index.ts and all middleware files to understand the current middleware stack.',
      context: 'Adding rate limiting to a Node.js API. Need to understand middleware insertion point.',
      dependsOn: [] as string[],
    },
    {
      id: 'step-2',
      specialist: 'coder' as const,
      task: 'Implement rate-limiting middleware and unit tests.',
      context: 'Insert before route handlers in src/server/index.ts.',
      dependsOn: ['step-1'] as string[],
    },
    {
      id: 'step-3',
      specialist: 'reviewer' as const,
      task: 'Review implementation for correctness and test coverage.',
      context: 'Verify limiter is correctly scoped to API routes.',
      dependsOn: ['step-2'] as string[],
    },
  ];

  const mergedSteps = overrides.stepOverrides
    ? baseSteps.map((s, i) => ({ ...s, ...(overrides.stepOverrides?.[i] ?? {}) }))
    : baseSteps;

  return JSON.stringify({ goal, steps: mergedSteps });
}

/** A valid single-step coder plan. */
function singleStepCoderPlanJSON(): string {
  return JSON.stringify({
    goal: 'Fix typo in README.md',
    steps: [
      {
        id: 'step-1',
        specialist: 'coder',
        task: 'Fix the typo in README.md line 5.',
        context: 'Simple single-file fix. No dependencies.',
        dependsOn: [],
      },
    ],
  });
}

/** A plan with two parallel first steps (both depend on nothing). */
function parallelPlanJSON(): string {
  return JSON.stringify({
    goal: 'Add auth module and logging',
    steps: [
      {
        id: 'step-1',
        specialist: 'coder',
        task: 'Implement auth module',
        context: 'New module, no dependencies.',
        dependsOn: [],
      },
      {
        id: 'step-2',
        specialist: 'coder',
        task: 'Implement logging module',
        context: 'New module, no dependencies.',
        dependsOn: [],
      },
      {
        id: 'step-3',
        specialist: 'reviewer',
        task: 'Review both modules',
        context: 'Review auth and logging together.',
        dependsOn: ['step-1', 'step-2'],
      },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Invalid / edge-case response factories
// ─────────────────────────────────────────────────────────────────────────────

/** Plan with circular dependency (step-2 → step-1 and step-1 → step-2). */
function circularDepPlanJSON(): string {
  return JSON.stringify({
    goal: 'Circular dependency test',
    steps: [
      { id: 'step-1', specialist: 'coder', task: 'Task 1', context: '', dependsOn: ['step-2'] },
      { id: 'step-2', specialist: 'coder', task: 'Task 2', context: '', dependsOn: ['step-1'] },
    ],
  });
}

/** Plan with a dependsOn reference to a non-existent step id. */
function unknownDepPlanJSON(): string {
  return JSON.stringify({
    goal: 'Unknown dependency test',
    steps: [
      { id: 'step-1', specialist: 'coder', task: 'Task 1', context: '', dependsOn: [] },
      { id: 'step-2', specialist: 'coder', task: 'Task 2', context: '', dependsOn: ['step-99'] },
    ],
  });
}

/** Plan with empty steps array. */
function emptyStepsPlanJSON(): string {
  return JSON.stringify({ goal: 'Empty steps test', steps: [] });
}

/** Plan with an invalid specialist value. */
function invalidSpecialistPlanJSON(): string {
  return JSON.stringify({
    goal: 'Invalid specialist test',
    steps: [
      { id: 'step-1', specialist: 'janitor', task: 'Clean up', context: '', dependsOn: [] },
    ],
  });
}

/** Plan where a step depends on itself. */
function selfDepPlanJSON(): string {
  return JSON.stringify({
    goal: 'Self-dependency test',
    steps: [
      { id: 'step-1', specialist: 'coder', task: 'Task 1', context: '', dependsOn: ['step-1'] },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: convert a raw string into an LLMResponse
// ─────────────────────────────────────────────────────────────────────────────
function response(text: string): LLMResponse {
  return { text, toolCalls: [], stopReason: 'done' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: validate ExecutionPlan shape
// ─────────────────────────────────────────────────────────────────────────────
function assertValidPlan(plan: ExecutionPlan): void {
  expect(plan).toBeDefined();
  expect(typeof plan.id).toBe('string');
  expect(plan.id.length).toBeGreaterThan(0);
  expect(typeof plan.goal).toBe('string');
  expect(plan.goal.length).toBeGreaterThan(0);
  expect(Array.isArray(plan.steps)).toBe(true);
  expect(plan.steps.length).toBeGreaterThan(0);
  expect(['pending', 'running', 'done', 'failed', 'aborted']).toContain(plan.status);
  expect(typeof plan.created).toBe('number');
  expect(plan.created).toBeGreaterThan(0);

  for (const step of plan.steps) {
    expect(typeof step.id).toBe('string');
    expect(step.id.length).toBeGreaterThan(0);
    expect(['researcher', 'coder', 'reviewer', 'planner']).toContain(step.specialist);
    expect(typeof step.task).toBe('string');
    expect(typeof step.context).toBe('string');
    expect(Array.isArray(step.dependsOn)).toBe(true);
    expect(['waiting', 'running', 'done', 'failed', 'skipped']).toContain(step.status);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// createPlan — happy path: plan shape
// ─────────────────────────────────────────────────────────────────────────────
describe('createPlan — happy path: plan shape', () => {
  it('returns valid ExecutionPlan with correct shape', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting to the Express API',
    });

    assertValidPlan(plan);
  });

  it('plan has id (non-empty string)', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
    });

    expect(plan.id.length).toBeGreaterThan(0);
    expect(typeof plan.id).toBe('string');
  });

  it('plan status is pending', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
    });

    expect(plan.status).toBe('pending');
  });

  it('plan created is a recent timestamp', async () => {
    const before = Date.now();
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
    });
    const after = Date.now();

    expect(plan.created).toBeGreaterThanOrEqual(before);
    expect(plan.created).toBeLessThanOrEqual(after);
  });

  it('all steps have ids', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
    });

    for (const step of plan.steps) {
      expect(typeof step.id).toBe('string');
      expect(step.id.length).toBeGreaterThan(0);
    }
  });

  it('all steps have status waiting', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
    });

    for (const step of plan.steps) {
      expect(step.status).toBe('waiting');
    }
  });

  it('steps with dependsOn reference valid step ids', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
    });

    const stepIds = new Set(plan.steps.map(s => s.id));
    for (const step of plan.steps) {
      for (const depId of step.dependsOn) {
        expect(stepIds.has(depId),
          `Step "${step.id}" depends on unknown step "${depId}"`).toBe(true);
      }
    }
  });

  it('goal matches the original task', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON({
      goal: 'Add rate limiting middleware to the Express API.',
    }))]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting middleware to the Express API.',
    });

    expect(plan.goal).toBe('Add rate limiting middleware to the Express API.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createPlan — happy path: multi-step plan
// ─────────────────────────────────────────────────────────────────────────────
describe('createPlan — happy path: multi-step plan', () => {
  it('returns plan with multiple steps for complex task', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting middleware',
    });

    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
  });

  it('steps are in correct dependency order', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
    });

    // Step ids that appear as dependsOn must appear earlier in the array
    const stepPosition = new Map<string, number>();
    plan.steps.forEach((s, idx) => stepPosition.set(s.id, idx));

    for (const step of plan.steps) {
      for (const depId of step.dependsOn) {
        const depPos = stepPosition.get(depId);
        const myPos = stepPosition.get(step.id)!;
        expect(depPos).toBeDefined();
        expect(depPos!).toBeLessThan(myPos);
      }
    }
  });

  it('no circular dependencies', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
    });

    // Run a simple DFS cycle detection on the DAG
    const adj = new Map<string, string[]>();
    for (const step of plan.steps) {
      adj.set(step.id, step.dependsOn);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();

    function hasCycle(node: string): boolean {
      if (visiting.has(node)) return true;
      if (visited.has(node)) return false;
      visiting.add(node);
      for (const dep of adj.get(node) ?? []) {
        if (hasCycle(dep)) return true;
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    }

    for (const step of plan.steps) {
      expect(hasCycle(step.id)).toBe(false);
    }
  });

  it('all specialist values are valid enum values', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
    });

    const valid = ['researcher', 'coder', 'reviewer', 'planner'];
    for (const step of plan.steps) {
      expect(valid).toContain(step.specialist);
    }
  });

  it('handles parallel initial steps correctly', async () => {
    const provider = new MockProvider([response(parallelPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add auth module and logging',
    });

    assertValidPlan(plan);
    expect(plan.steps).toHaveLength(3);
    // First two steps have no dependencies (can run in parallel)
    expect(plan.steps[0].dependsOn).toEqual([]);
    expect(plan.steps[1].dependsOn).toEqual([]);
    // Third step depends on both (IDs may be normalised by implementation)
    const stepIds = plan.steps.map(s => s.id);
    expect(plan.steps[2].dependsOn).toHaveLength(2);
    expect(plan.steps[2].dependsOn).toContain(stepIds[0]);
    expect(plan.steps[2].dependsOn).toContain(stepIds[1]);
  });

  it('single-step plan is also valid', async () => {
    const provider = new MockProvider([response(singleStepCoderPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Fix typo in README',
    });

    assertValidPlan(plan);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].dependsOn).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createPlan — fallback behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe('createPlan — fallback behaviour', () => {
  it('returns single-step coder plan when provider returns invalid JSON', async () => {
    const provider = new MockProvider([response('{ not valid json at all')]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Fix the auth bug',
    });

    assertValidPlan(plan);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].specialist).toBe('coder');
  });

  it('returns single-step coder plan when provider throws', async () => {
    const provider = new MockProvider([]); // empty queue → throws
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Fix the auth bug',
    });

    assertValidPlan(plan);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].specialist).toBe('coder');
  });

  it('returns single-step coder plan when response is empty', async () => {
    const provider = new MockProvider([response('')]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Fix the auth bug',
    });

    assertValidPlan(plan);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].specialist).toBe('coder');
  });

  it('fallback plan has status pending and step status waiting', async () => {
    const provider = new MockProvider([response('garbage')]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Any task',
    });

    expect(plan.status).toBe('pending');
    expect(plan.steps[0].status).toBe('waiting');
  });

  it('fallback plan goal matches the original task', async () => {
    const provider = new MockProvider([]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Fix the authentication bug in core/auth.ts',
    });

    expect(plan.goal).toBe('Fix the authentication bug in core/auth.ts');
  });

  it('fallback plan has a valid id', async () => {
    const provider = new MockProvider([]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Some task',
    });

    expect(plan.id.length).toBeGreaterThan(0);
  });

  it('never throws under any circumstances', async () => {
    class ThrowingProvider implements LLMProvider {
      name = 'Thrower';
      model = 'thrower';
      supportsTools = false;
      async complete(): Promise<LLMResponse> {
        throw new Error('Fatal provider crash');
      }
      async *stream(): AsyncGenerator<StreamChunk> {
        throw new Error('Fatal provider crash');
      }
    }

    await expect(
      createPlan({ context: mockContext, provider: new ThrowingProvider(), task: 'task' }),
    ).resolves.toBeDefined();
    await expect(
      createPlan({ context: mockContext, provider: new ThrowingProvider(), task: '' }),
    ).resolves.toBeDefined();
    await expect(
      createPlan({
        context: mockContext,
        provider: new ThrowingProvider(),
        task: 'task',
        perception: mockPerception,
      }),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createPlan — validation rejections
// ─────────────────────────────────────────────────────────────────────────────
describe('createPlan — validation rejections', () => {
  it('rejects circular dependencies → fallback plan', async () => {
    const provider = new MockProvider([response(circularDepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Some task',
    });

    assertValidPlan(plan);
    // Should fall back to a single-step coder plan instead of accepting circular deps
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].specialist).toBe('coder');
  });

  it('rejects unknown dependsOn ids → fallback plan', async () => {
    const provider = new MockProvider([response(unknownDepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Some task',
    });

    assertValidPlan(plan);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].specialist).toBe('coder');
  });

  it('rejects empty steps array → fallback plan', async () => {
    const provider = new MockProvider([response(emptyStepsPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Some task',
    });

    assertValidPlan(plan);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].specialist).toBe('coder');
  });

  it('rejects invalid specialist values → fallback plan', async () => {
    const provider = new MockProvider([response(invalidSpecialistPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Some task',
    });

    assertValidPlan(plan);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].specialist).toBe('coder');
  });

  it('rejects self-dependency → fallback plan', async () => {
    const provider = new MockProvider([response(selfDepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Some task',
    });

    assertValidPlan(plan);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].specialist).toBe('coder');
  });

  it('rejects plan where steps is not an array → fallback plan', async () => {
    const provider = new MockProvider([response(JSON.stringify({
      goal: 'bad',
      steps: { not: 'an array' },
    }))]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Some task',
    });

    assertValidPlan(plan);
    expect(plan.steps).toHaveLength(1);
  });

  it('rejects plan with missing goal field → fallback plan', async () => {
    const provider = new MockProvider([response(JSON.stringify({
      steps: [
        { id: 'step-1', specialist: 'coder', task: 'Do it', context: '', dependsOn: [] },
      ],
    }))]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Some task',
    });

    assertValidPlan(plan);
    // Fallback plan should preserve the original task as goal
    expect(plan.goal).toBe('Some task');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createPlan — with memory
// ─────────────────────────────────────────────────────────────────────────────
describe('createPlan — with memory', () => {
  const memoryEntries: OrchestrationMemory[] = [
    {
      key: 'auth_strategy',
      value: 'JWT with refresh tokens',
      stepId: 'prev-step-3',
      timestamp: 1_700_000_000_000,
    },
    {
      key: 'db_schema',
      value: 'users(id, email, password_hash)',
      stepId: 'prev-step-1',
      timestamp: 1_699_000_000_000,
    },
  ];

  it('still returns valid plan when memory is provided', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
      memory: memoryEntries,
    });

    assertValidPlan(plan);
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
  });

  it('still returns valid plan when memory is null', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
      memory: null as unknown as OrchestrationMemory[] | undefined,
    });

    assertValidPlan(plan);
  });

  it('still returns valid plan when memory is undefined', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
    });

    assertValidPlan(plan);
  });

  it('still returns valid plan when memory is an empty array', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
      memory: [],
    });

    assertValidPlan(plan);
  });

  it('handles provider errors with memory provided → fallback', async () => {
    const provider = new MockProvider([]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Some task',
      memory: memoryEntries,
    });

    assertValidPlan(plan);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].specialist).toBe('coder');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createPlan — with perception
// ─────────────────────────────────────────────────────────────────────────────
describe('createPlan — with perception', () => {
  it('still returns valid plan when perception is provided', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add auth to database layer',
      perception: mockPerception,
    });

    assertValidPlan(plan);
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
  });

  it('still returns valid plan when perception is null', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
      perception: null as unknown as ProjectPerception | undefined,
    });

    assertValidPlan(plan);
  });

  it('still returns valid plan when perception is undefined', async () => {
    const provider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Add rate limiting',
    });

    assertValidPlan(plan);
  });

  it('handles provider errors with perception → fallback', async () => {
    const provider = new MockProvider([]);
    const plan = await createPlan({
      provider,
      context: mockContext,
      task: 'Critical auth fix',
      perception: mockPerception,
    });

    assertValidPlan(plan);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].specialist).toBe('coder');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR_SYSTEM_PROMPT
// ─────────────────────────────────────────────────────────────────────────────
describe('ORCHESTRATOR_SYSTEM_PROMPT', () => {
  it('returns a non-empty string', () => {
    const prompt = ORCHESTRATOR_SYSTEM_PROMPT(mockContext);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('contains the project name', () => {
    const prompt = ORCHESTRATOR_SYSTEM_PROMPT(mockContext);
    expect(prompt).toContain('aura-code');
  });

  it('contains all four specialist names', () => {
    const prompt = ORCHESTRATOR_SYSTEM_PROMPT(mockContext);

    expect(prompt).toContain('researcher');
    expect(prompt).toContain('coder');
    expect(prompt).toContain('reviewer');
    expect(prompt).toContain('planner');
  });

  it('contains instruction to output JSON', () => {
    const prompt = ORCHESTRATOR_SYSTEM_PROMPT(mockContext);
    expect(prompt).toMatch(/JSON|json/);
  });

  it('does NOT contain risk areas when perception is undefined', () => {
    const prompt = ORCHESTRATOR_SYSTEM_PROMPT(mockContext, undefined);
    expect(prompt).not.toContain('Risk areas');
    expect(prompt).not.toContain('security-critical');
  });

  it('does NOT contain risk areas when perception has empty risk areas', () => {
    const emptyPerception: ProjectPerception = {
      ...mockPerception,
      constraints: { ...mockPerception.constraints, riskAreas: [] },
    };
    const prompt = ORCHESTRATOR_SYSTEM_PROMPT(mockContext, emptyPerception);
    expect(prompt).not.toContain('Risk areas');
  });

  it('includes risk areas when perception has them', () => {
    const prompt = ORCHESTRATOR_SYSTEM_PROMPT(mockContext, mockPerception);
    expect(prompt).toContain('Risk areas');
    expect(prompt).toContain('security-critical');
    expect(prompt).toContain('legacy-refactor');
  });

  it('includes strict rules when perception has them', () => {
    const prompt = ORCHESTRATOR_SYSTEM_PROMPT(mockContext, mockPerception);
    expect(prompt).toContain('Strict rules');
    expect(prompt).toContain('No circular deps in core/');
  });

  it('includes read-only paths when perception has them', () => {
    const prompt = ORCHESTRATOR_SYSTEM_PROMPT(mockContext, mockPerception);
    expect(prompt).toContain('Read-only paths');
    expect(prompt).toContain('package-lock.json');
  });

  it('contains GOOD EXAMPLE and BAD EXAMPLE sections', () => {
    const prompt = ORCHESTRATOR_SYSTEM_PROMPT(mockContext);
    expect(prompt).toContain('GOOD EXAMPLE');
    expect(prompt).toContain('BAD EXAMPLE');
  });

  it('changes between calls with vs without perception risk areas', () => {
    const without = ORCHESTRATOR_SYSTEM_PROMPT(mockContext, undefined);
    const withPerception = ORCHESTRATOR_SYSTEM_PROMPT(mockContext, mockPerception);
    expect(withPerception.length).toBeGreaterThan(without.length);
    expect(withPerception).not.toBe(without);
  });

  it('contains the project language and framework', () => {
    const prompt = ORCHESTRATOR_SYSTEM_PROMPT(mockContext);
    expect(prompt).toContain('TypeScript');
    expect(prompt).toContain('Node.js');
  });
});
