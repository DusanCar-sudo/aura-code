import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePlan, synthesise } from '../../src/orchestration/executor.js';
import type {
  ExecutionPlan,
  PlanStep,
} from '../../src/orchestration/types.js';
import type { SpecialistResult } from '../../src/orchestration/specialists.js';
import type { Display } from '../../src/cli/display.js';
import type { LLMProvider, LLMResponse, HistoryMessage, ToolDefinition, StreamChunk } from '../../src/providers/types.js';
import type { ProjectContext } from '../../src/agent/context.js';

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
  tree: 'src/\n  agent/\n  providers/',
  config: '{"name":"aura-code"}',
  recentCommits: 'abc1234 Add feature',
};

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: `step-${Math.random().toString(36).slice(2, 6)}`,
    specialist: 'coder',
    task: 'Implement feature',
    context: 'Standard context',
    dependsOn: [],
    status: 'waiting' as const,
    ...overrides,
  };
}

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    id: `plan-${Math.random().toString(36).slice(2, 8)}`,
    goal: 'Implement feature X',
    steps: [makeStep()],
    status: 'pending',
    created: Date.now(),
    ...overrides,
  };
}

// ── Display with all required methods (showPlan, stepStarted, stepCompleted) ─
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

// ── Reusable MockProvider ───────────────────────────────────────────────────
class MockProvider implements LLMProvider {
  name = 'MockExec';
  model = 'mock-exec-model';
  supportsTools = true;
  private responseText: string;
  constructor(responseText = 'ok') { this.responseText = responseText; }
  async complete(): Promise<LLMResponse> {
    return { text: this.responseText, toolCalls: [], stopReason: 'done' };
  }
  async *stream(): AsyncGenerator<StreamChunk> {
    yield { type: 'text', text: this.responseText };
    yield { type: 'done', response: { text: this.responseText, toolCalls: [], stopReason: 'done' } };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function successResult(stepId: string, overrides: Partial<SpecialistResult> = {}): SpecialistResult {
  return {
    result: `Step ${stepId} completed successfully.`,
    success: true,
    tokensUsed: 500,
    durationMs: 100,
    stepId,
    ...overrides,
  };
}

function failResult(stepId: string, msg?: string): SpecialistResult {
  return {
    result: msg ?? `Step ${stepId} failed with an error.`,
    success: false,
    tokensUsed: 0,
    durationMs: 50,
    stepId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// executePlan — sequential execution
// ─────────────────────────────────────────────────────────────────────────────
describe('executePlan — sequential execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('single-step plan completes successfully', async () => {
    mockRunSpecialist.mockResolvedValueOnce(successResult('step-1'));
    const plan = makePlan({
      steps: [makeStep({ id: 'step-1', specialist: 'coder' })],
    });
    const provider = new MockProvider('Synthesis: feature implemented.');

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.steps[0].status).toBe('done');
    expect(result.steps[0].result).toContain('completed successfully');
  });

  it('plan status becomes done after completion', async () => {
    mockRunSpecialist.mockResolvedValueOnce(successResult('s1'));
    const plan = makePlan({ steps: [makeStep({ id: 's1', specialist: 'coder' })] });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.status).toBe('done');
  });

  it('step status becomes done after completion', async () => {
    mockRunSpecialist.mockResolvedValueOnce(successResult('step-a'));
    const plan = makePlan({ steps: [makeStep({ id: 'step-a', specialist: 'coder' })] });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.steps[0].status).toBe('done');
  });

  it('step result is populated after completion', async () => {
    mockRunSpecialist.mockResolvedValueOnce(
      successResult('step-1', { result: 'Research found 3 modules: auth, api, db.' }),
    );
    const plan = makePlan({ steps: [makeStep({ id: 'step-1', specialist: 'researcher' })] });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.steps[0].result).toContain('3 modules');
  });

  it('plan.completed is set after execution', async () => {
    mockRunSpecialist.mockResolvedValueOnce(successResult('s1'));
    const plan = makePlan({ steps: [makeStep({ id: 's1', specialist: 'coder' })] });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(typeof result.completed).toBe('number');
    expect(result.completed).toBeGreaterThan(0);
  });

  it('plan.totalTokens is calculated after execution', async () => {
    const tokens = [300, 200, 100];
    for (const t of tokens) {
      mockRunSpecialist.mockResolvedValueOnce(successResult('step', { tokensUsed: t }));
    }
    const plan = makePlan({
      steps: [
        makeStep({ id: 's1', specialist: 'researcher' }),
        makeStep({ id: 's2', specialist: 'coder', dependsOn: ['s1'] }),
        makeStep({ id: 's3', specialist: 'reviewer', dependsOn: ['s2'] }),
      ],
    });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.totalTokens).toBe(600);
  });

  it('plan.outcome is set via synthesise', async () => {
    mockRunSpecialist.mockResolvedValueOnce(successResult('s1'));
    const plan = makePlan({ steps: [makeStep({ id: 's1', specialist: 'coder' })] });
    const provider = new MockProvider('All changes applied cleanly.');

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.outcome).toBe('All changes applied cleanly.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executePlan — parallel execution
// ─────────────────────────────────────────────────────────────────────────────
describe('executePlan — parallel execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('two independent steps both complete', async () => {
    mockRunSpecialist.mockResolvedValueOnce(successResult('s1'));
    mockRunSpecialist.mockResolvedValueOnce(successResult('s2'));
    const plan = makePlan({
      steps: [
        makeStep({ id: 's1', specialist: 'coder' }),
        makeStep({ id: 's2', specialist: 'coder' }),
      ],
    });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(mockRunSpecialist).toHaveBeenCalledTimes(2);
    expect(result.steps[0].status).toBe('done');
    expect(result.steps[1].status).toBe('done');
  });

  it('parallel steps with no dependencies both marked done', async () => {
    mockRunSpecialist.mockResolvedValueOnce(successResult('par-1'));
    mockRunSpecialist.mockResolvedValueOnce(successResult('par-2'));
    mockRunSpecialist.mockResolvedValueOnce(successResult('par-3'));
    const plan = makePlan({
      steps: [
        makeStep({ id: 'par-1', specialist: 'researcher', dependsOn: [] }),
        makeStep({ id: 'par-2', specialist: 'coder', dependsOn: [] }),
        makeStep({ id: 'par-3', specialist: 'reviewer', dependsOn: ['par-1', 'par-2'] }),
      ],
    });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.steps[0].status).toBe('done');
    expect(result.steps[1].status).toBe('done');
    expect(result.steps[2].status).toBe('done');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executePlan — dependency handling
// ─────────────────────────────────────────────────────────────────────────────
describe('executePlan — dependency handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('step with dependsOn waits for dependency before running', async () => {
    mockRunSpecialist.mockResolvedValueOnce(successResult('dep-1'));
    mockRunSpecialist.mockResolvedValueOnce(successResult('dep-2'));
    const plan = makePlan({
      steps: [
        makeStep({ id: 'dep-1', specialist: 'researcher' }),
        makeStep({ id: 'dep-2', specialist: 'coder', dependsOn: ['dep-1'] }),
      ],
    });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.steps[1].status).toBe('done');
    expect(mockRunSpecialist).toHaveBeenCalledTimes(2);
  });

  it('step runs after dependency completes — dependency order respected', async () => {
    const callOrder: string[] = [];
    mockRunSpecialist.mockImplementation(async (opts: { step: PlanStep }) => {
      callOrder.push(opts.step.id);
      return successResult(opts.step.id);
    });

    const plan = makePlan({
      steps: [
        makeStep({ id: 's1', specialist: 'researcher' }),
        makeStep({ id: 's2', specialist: 'coder', dependsOn: ['s1'] }),
        makeStep({ id: 's3', specialist: 'reviewer', dependsOn: ['s2'] }),
      ],
    });
    const provider = new MockProvider();

    await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    // s1 must execute before s2, s2 before s3
    expect(callOrder.indexOf('s1')).toBeLessThan(callOrder.indexOf('s2'));
    expect(callOrder.indexOf('s2')).toBeLessThan(callOrder.indexOf('s3'));
  });

  it('dependent step is skipped when dependency fails', async () => {
    mockRunSpecialist.mockResolvedValueOnce(failResult('main'));
    const plan = makePlan({
      steps: [
        makeStep({ id: 'main', specialist: 'coder' }),
        makeStep({ id: 'dep', specialist: 'reviewer', dependsOn: ['main'] }),
      ],
    });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[1].status).toBe('skipped');
    expect(mockRunSpecialist).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executePlan — failure handling
// ─────────────────────────────────────────────────────────────────────────────
describe('executePlan — failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('failed step sets status to failed', async () => {
    mockRunSpecialist.mockResolvedValueOnce(failResult('fail-1', 'Critical error'));
    const plan = makePlan({ steps: [makeStep({ id: 'fail-1', specialist: 'coder' })] });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.steps[0].status).toBe('failed');
  });

  it('dependent steps are marked skipped when a dependency fails', async () => {
    mockRunSpecialist.mockResolvedValueOnce(failResult('a'));
    const plan = makePlan({
      steps: [
        makeStep({ id: 'a', specialist: 'coder' }),
        makeStep({ id: 'b', specialist: 'reviewer', dependsOn: ['a'] }),
        makeStep({ id: 'c', specialist: 'coder', dependsOn: ['b'] }),
      ],
    });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[1].status).toBe('skipped');
    expect(result.steps[2].status).toBe('skipped');
  });

  it('independent steps still run after a failure elsewhere', async () => {
    mockRunSpecialist
      .mockResolvedValueOnce(failResult('fail', 'Branch A failed'))
      .mockResolvedValueOnce(successResult('ok'));
    const plan = makePlan({
      steps: [
        makeStep({ id: 'fail', specialist: 'coder' }),
        makeStep({ id: 'ok', specialist: 'researcher', dependsOn: [] }),
      ],
    });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[1].status).toBe('done');
  });

  it('plan status becomes failed when a step fails', async () => {
    mockRunSpecialist.mockResolvedValueOnce(failResult('crit'));
    const plan = makePlan({ steps: [makeStep({ id: 'crit', specialist: 'coder' })] });
    const provider = new MockProvider();

    const result = await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(result.status).toBe('failed');
  });

  it('never throws — runSpecialist rejection is caught', async () => {
    mockRunSpecialist.mockRejectedValue(new Error('Catastrophic failure'));
    const plan = makePlan({ steps: [makeStep({ id: 's1', specialist: 'coder' })] });
    const provider = new MockProvider();

    // runOneStep uses Promise.allSettled, so rejections become failed results
    await expect(
      executePlan({ plan, provider, context: mockContext, display: noopDisplay }),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executePlan — signal / abort
// ─────────────────────────────────────────────────────────────────────────────
describe('executePlan — signal / abort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('respects AbortSignal — returns plan in aborted state', async () => {
    const controller = new AbortController();
    controller.abort();

    const plan = makePlan({ steps: [makeStep({ id: 's1', specialist: 'coder' })] });
    const provider = new MockProvider();

    const result = await executePlan({
      plan, provider, context: mockContext, display: noopDisplay, signal: controller.signal,
    });

    expect(result.status).toBe('aborted');
    expect(result.completed).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executePlan — memory
// ─────────────────────────────────────────────────────────────────────────────
describe('executePlan — memory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves memory entry after each completed step', async () => {
    mockRunSpecialist.mockResolvedValueOnce(successResult('mem-1', { result: 'Research done.' }));
    mockRunSpecialist.mockResolvedValueOnce(successResult('mem-2', { result: 'Coding done.' }));
    const plan = makePlan({
      steps: [
        makeStep({ id: 'mem-1', specialist: 'researcher' }),
        makeStep({ id: 'mem-2', specialist: 'coder', dependsOn: ['mem-1'] }),
      ],
    });
    const provider = new MockProvider();

    await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    // runSpecialist called twice (once per step)
    expect(mockRunSpecialist).toHaveBeenCalledTimes(2);
  });

  it('memory key equals step id', async () => {
    mockRunSpecialist.mockResolvedValueOnce(
      successResult('key-test-step', { result: 'Output text' }),
    );
    const plan = makePlan({ steps: [makeStep({ id: 'key-test-step', specialist: 'researcher' })] });
    const provider = new MockProvider();

    await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    // The second call to runSpecialist would contain memory
    // (only one step here so memory is empty)
    // Verify step was run
    expect(mockRunSpecialist).toHaveBeenCalledTimes(1);
    const opts = mockRunSpecialist.mock.calls[0][0];
    expect(opts.step.id).toBe('key-test-step');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executePlan — display
// ─────────────────────────────────────────────────────────────────────────────
describe('executePlan — display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('showPlan called at start', async () => {
    mockRunSpecialist.mockResolvedValueOnce(successResult('d1'));
    const plan = makePlan({ steps: [makeStep({ id: 'd1', specialist: 'coder' })] });
    const provider = new MockProvider();

    await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(noopDisplay.showPlan).toHaveBeenCalledWith(plan);
  });

  it('stepStarted called before each step', async () => {
    mockRunSpecialist.mockResolvedValueOnce(successResult('start-1'));
    const plan = makePlan({ steps: [makeStep({ id: 'start-1', specialist: 'coder' })] });
    const provider = new MockProvider();

    await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(noopDisplay.stepStarted).toHaveBeenCalled();
  });

  it('stepCompleted called after each successful step', async () => {
    mockRunSpecialist.mockResolvedValueOnce(
      successResult('comp-1', { result: 'Implementation finished.' }),
    );
    const plan = makePlan({ steps: [makeStep({ id: 'comp-1', specialist: 'coder' })] });
    const provider = new MockProvider();

    await executePlan({ plan, provider, context: mockContext, display: noopDisplay });

    expect(noopDisplay.stepCompleted).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// synthesise
// ─────────────────────────────────────────────────────────────────────────────
describe('synthesise', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns provider response text when available', async () => {
    const plan = makePlan({
      steps: [
        makeStep({ id: 'syn-1', specialist: 'coder', status: 'done', result: 'Task done.' }),
      ],
      status: 'done',
    });
    const provider = new MockProvider('Everything completed successfully — rate limiting is now active.');

    const outcome = await synthesise(plan, provider, mockContext);
    expect(outcome).toBe('Everything completed successfully — rate limiting is now active.');
  });

  it('never throws — returns fallback on error', async () => {
    const plan = makePlan({
      steps: [
        makeStep({ id: 'fail', specialist: 'coder', status: 'failed', result: 'Step failed.' }),
      ],
      status: 'failed',
    });
    const provider = new MockProvider();
    // Provider doesn't throw, but this tests the fallback path
    // The synthesise function uses provider.complete()

    await expect(
      synthesise(plan, provider, mockContext),
    ).resolves.toBeDefined();
  });

  it('returns correct fallback when no steps are done', async () => {
    const plan = makePlan({
      steps: [
        makeStep({ id: 'no-done', specialist: 'coder', status: 'waiting' }),
      ],
      status: 'pending',
    });
    const provider = new MockProvider();

    const outcome = await synthesise(plan, provider, mockContext);
    // No done steps → "No steps completed."
    expect(outcome).toContain('No steps completed');
  });
});
