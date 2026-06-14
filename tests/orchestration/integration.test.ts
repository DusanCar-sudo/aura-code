import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeTask, type RouterOptions } from '../../src/orchestration/router.js';
import { createPlan, type OrchestratorOptions } from '../../src/orchestration/orchestrator.js';
import { executePlan, synthesise, type ExecutorOptions } from '../../src/orchestration/executor.js';
import type { ExecutionPlan } from '../../src/orchestration/types.js';
import type { SpecialistResult } from '../../src/orchestration/specialists.js';
import type { Display } from '../../src/cli/display.js';
import type { ProjectContext } from '../../src/agent/context.js';
import type { ProjectPerception } from '../../src/perception/types.js';
import type { LLMProvider, LLMResponse, HistoryMessage, ToolDefinition, StreamChunk } from '../../src/providers/types.js';

// ── Mock runSpecialist — avoids real LLM calls ──────────────────────────────
const mockRunSpecialist = vi.fn();

vi.mock('../../src/orchestration/specialists.js', () => ({
  runSpecialist: (...args: unknown[]) => mockRunSpecialist(...args),
  runResearcher: (...args: unknown[]) => mockRunSpecialist(...args),
  runReviewer: (...args: unknown[]) => mockRunSpecialist(...args),
  runCoder: (...args: unknown[]) => mockRunSpecialist(...args),
}));

// ── Mock planStore — avoids real disk writes ────────────────────────────────
vi.mock('../../src/orchestration/plan-store.js', () => ({
  planStore: {
    save: vi.fn().mockResolvedValue(undefined),
    saveMemory: vi.fn().mockResolvedValue(undefined),
  },
}));

// ── Fixtures ────────────────────────────────────────────────────────────────
const mockContext: ProjectContext = {
  root: '/fake/project',
  name: 'aura-code',
  language: 'TypeScript',
  framework: 'Node.js',
  readme: '# Aura',
  tree: 'src/\n  agent/\n  providers/\n  orchestration/',
  config: '{"name":"aura-code"}',
  recentCommits: 'abc1234 Add orchestration layer',
};

const mockPerception: ProjectPerception = {
  projectRoot: '/fake/project',
  nodes: [{ id: 'core/auth', type: 'module', label: 'Auth module', description: 'Auth', metadata: { riskArea: 'security-critical' } }],
  edges: [],
  trajectory: { vision: 'Build a secure platform', deprecated: [], inProgress: [], planned: [] },
  constraints: {
    readOnly: ['package-lock.json'],
    strictRules: ['No circular deps in core/'],
    riskAreas: ['security-critical'],
    testCoverage: [{ module: 'core', coverage: 'high' }],
  },
  extractedAt: Date.now(),
  version: '1.0.0',
};

// ── Response factories ──────────────────────────────────────────────────────
function decomposeDecisionJSON(): string {
  return JSON.stringify({
    shouldDecompose: true,
    reason: 'Task spans multiple modules — needs orchestration.',
    confidence: 0.85,
    estimatedSteps: 3,
  });
}

function threeStepPlanJSON(): string {
  return JSON.stringify({
    goal: 'Add rate limiting middleware to the Express API.',
    steps: [
      { id: 'step-1', specialist: 'researcher', task: 'Research middleware stack', context: 'Understand insertion point.', dependsOn: [] },
      { id: 'step-2', specialist: 'coder', task: 'Implement rate-limiting middleware', context: 'Insert before route handlers.', dependsOn: ['step-1'] },
      { id: 'step-3', specialist: 'reviewer', task: 'Review implementation', context: 'Verify scope and coverage.', dependsOn: ['step-2'] },
    ],
  });
}

// ── MockProvider with queued responses ──────────────────────────────────────
class MockProvider implements LLMProvider {
  name = 'MockIntegration';
  model = 'mock-int-model';
  supportsTools = false;
  private responses: LLMResponse[];
  constructor(responses: LLMResponse[]) {
    this.responses = [...responses];
  }
  async complete(): Promise<LLMResponse> {
    const next = this.responses.shift();
    if (!next) throw new Error('No more responses');
    return next;
  }
  async *stream(): AsyncGenerator<StreamChunk> {
    const next = this.responses.shift();
    if (!next) throw new Error('No more responses');
    if (next.text) yield { type: 'text', text: next.text };
    yield { type: 'done', response: next };
  }
}

function response(text: string): LLMResponse {
  return { text, toolCalls: [], stopReason: 'done' };
}

// ── Display with all methods including showPlan/stepStarted/stepCompleted ──
const noopDisplay: Display = {
  showPlan: vi.fn() as Display['showPlan'],
  stepStarted: vi.fn() as Display['stepStarted'],
  stepCompleted: vi.fn() as Display['stepCompleted'],
  agentThinking: vi.fn(),
  streamText: vi.fn(),
  streamEnd: vi.fn(),
  toolStart: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  toolBlocked: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  header: vi.fn(),
  summary: vi.fn(),
};

function successResult(stepId: string): SpecialistResult {
  return { result: `Step ${stepId} completed successfully.`, success: true, tokensUsed: 500, durationMs: 100, stepId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full pipeline integration tests
// ─────────────────────────────────────────────────────────────────────────────
describe('orchestration pipeline integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routeTask → createPlan → executePlan → synthesise: full pipeline', async () => {
    // ── 1. Route ─────────────────────────────────────────────────────────
    const routerProvider = new MockProvider([response(decomposeDecisionJSON())]);
    const decision = await routeTask({
      provider: routerProvider, context: mockContext,
      task: 'Add rate limiting middleware to the Express API', perception: mockPerception,
    });
    expect(decision.shouldDecompose).toBe(true);

    // ── 2. Plan ──────────────────────────────────────────────────────────
    const plannerProvider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider: plannerProvider, context: mockContext,
      task: 'Add rate limiting middleware to the Express API', perception: mockPerception,
    });
    expect(plan.steps.length).toBe(3);
    expect(plan.steps[0].specialist).toBe('researcher');
    expect(plan.steps[1].specialist).toBe('coder');
    expect(plan.steps[2].specialist).toBe('reviewer');

    // ── 3. Execute ───────────────────────────────────────────────────────
    mockRunSpecialist
      .mockResolvedValueOnce(successResult(plan.steps[0].id))
      .mockResolvedValueOnce(successResult(plan.steps[1].id))
      .mockResolvedValueOnce(successResult(plan.steps[2].id));

    const execProvider = new MockProvider([
      response('All 3 steps completed — rate limiting middleware is now active.'),
    ]);
    const executed = await executePlan({
      plan, provider: execProvider, context: mockContext, display: noopDisplay, memory: [],
    });

    expect(executed.status).toBe('done');
    expect(executed.steps[0].status).toBe('done');
    expect(executed.steps[1].status).toBe('done');
    expect(executed.steps[2].status).toBe('done');
    expect(mockRunSpecialist).toHaveBeenCalledTimes(3);
    expect(executed.outcome).toContain('rate limiting');

    // ── 4. Synthesise ────────────────────────────────────────────────────
    const synthProvider = new MockProvider([response('Synthesis: rate limiting middleware deployed.')]);
    const outcome = await synthesise(executed, synthProvider, mockContext);
    expect(outcome).toContain('rate limiting');
  });

  it('all steps complete in correct dependency order', async () => {
    const plannerProvider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider: plannerProvider, context: mockContext,
      task: 'Add rate limiting', perception: mockPerception,
    });

    const callOrder: string[] = [];
    mockRunSpecialist.mockImplementation(async (opts: { step: { specialist: string; id: string } }) => {
      callOrder.push(opts.step.specialist);
      return successResult(opts.step.id);
    });

    const execProvider = new MockProvider([response('Done.')]);
    const executed = await executePlan({
      plan, provider: execProvider, context: mockContext, display: noopDisplay, memory: [],
    });
    expect(executed.status).toBe('done');
    expect(callOrder[0]).toBe('researcher');
    expect(callOrder[1]).toBe('coder');
    expect(callOrder[2]).toBe('reviewer');
  });

  it('memory is populated after each step', async () => {
    const plannerProvider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider: plannerProvider, context: mockContext,
      task: 'Add rate limiting', perception: mockPerception,
    });

    // Track memory passed to each specialist call
    const memoryPerCall: number[] = [];
    mockRunSpecialist.mockImplementation(async (opts: { memory: unknown[] }) => {
      memoryPerCall.push(opts.memory.length);
      return successResult('step');
    });

    const execProvider = new MockProvider([response('Done.')]);
    const executed = await executePlan({
      plan, provider: execProvider, context: mockContext, display: noopDisplay, memory: [],
    });
    expect(executed.status).toBe('done');
    expect(memoryPerCall.length).toBe(3);

    // First step: empty memory, second: 1 entry, third: 2 entries
    expect(memoryPerCall[0]).toBe(0);
    expect(memoryPerCall[1]).toBe(1);
    expect(memoryPerCall[2]).toBe(2);
  });

  it('plan captures completed timestamp and outcome', async () => {
    const plannerProvider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider: plannerProvider, context: mockContext,
      task: 'Add rate limiting', perception: mockPerception,
    });

    mockRunSpecialist
      .mockResolvedValueOnce(successResult(plan.steps[0].id))
      .mockResolvedValueOnce(successResult(plan.steps[1].id))
      .mockResolvedValueOnce(successResult(plan.steps[2].id));

    const execProvider = new MockProvider([response('All done — middleware active.')]);
    const executed = await executePlan({
      plan, provider: execProvider, context: mockContext, display: noopDisplay, memory: [],
    });

    expect(executed.status).toBe('done');
    expect(typeof executed.completed).toBe('number');
    expect(executed.completed).toBeGreaterThan(0);
    expect(executed.outcome).toBe('All done — middleware active.');
  });

  it('pipeline handles step failure correctly', async () => {
    const plannerProvider = new MockProvider([response(threeStepPlanJSON())]);
    const plan = await createPlan({
      provider: plannerProvider, context: mockContext,
      task: 'Add rate limiting', perception: mockPerception,
    });

    // First step fails
    mockRunSpecialist.mockResolvedValueOnce({
      result: 'Research error: cannot read files',
      success: false, tokensUsed: 0, durationMs: 50, stepId: plan.steps[0].id,
    });

    const execProvider = new MockProvider([response('Failed.')]);
    const executed = await executePlan({
      plan, provider: execProvider, context: mockContext, display: noopDisplay, memory: [],
    });

    expect(executed.steps[0].status).toBe('failed');
    expect(executed.steps[1].status).toBe('skipped');
    expect(executed.steps[2].status).toBe('skipped');
    expect(executed.status).toBe('failed');
    expect(mockRunSpecialist).toHaveBeenCalledTimes(1);
  });
});
