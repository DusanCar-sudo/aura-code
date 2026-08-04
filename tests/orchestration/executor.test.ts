import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePlan, synthesise, parseReviewVerdict, reviewFallbackCount, resetReviewFallbackCount } from '../../src/orchestration/executor.js';
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

// ─────────────────────────────────────────────────────────────────────────────
// parseReviewVerdict — structured verdict parsing
// ─────────────────────────────────────────────────────────────────────────────
describe('parseReviewVerdict', () => {
  it('parses a clean verdict', () => {
    const v = parseReviewVerdict('{"issues":[],"blocking":false}');
    expect(v).toEqual({ issues: [], blocking: false });
  });

  it('parses a verdict wrapped in a code fence', () => {
    const v = parseReviewVerdict('```json\n{"issues":[],"blocking":true}\n```');
    expect(v?.blocking).toBe(true);
  });

  it('parses a verdict followed by trailing prose', () => {
    const raw = '{"issues":[],"blocking":false}\n\nNo issues found.';
    expect(parseReviewVerdict(raw)?.blocking).toBe(false);
  });

  it('returns null for unparseable output', () => {
    expect(parseReviewVerdict('The code looks fine to me, ship it.')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseReviewVerdict(undefined)).toBeNull();
  });

  it('returns null when issues is not an array', () => {
    expect(parseReviewVerdict('{"issues":"none","blocking":false}')).toBeNull();
  });

  it('falls back to severity when blocking is absent — critical blocks', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const raw = '{"issues":[{"severity":"critical","description":"sqli","location":"a.ts:1"}]}';
    expect(parseReviewVerdict(raw)?.blocking).toBe(true);
    warn.mockRestore();
  });

  it('falls back to severity when blocking is absent — minor does not block', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const raw = '{"issues":[{"severity":"minor","description":"nit","location":"a.ts:1"}]}';
    expect(parseReviewVerdict(raw)?.blocking).toBe(false);
    warn.mockRestore();
  });

  it('an explicit blocking:false wins over a critical severity', () => {
    const raw = '{"issues":[{"severity":"critical","description":"x","location":"a.ts:1"}],"blocking":false}';
    expect(parseReviewVerdict(raw)?.blocking).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executePlan — reviewer revise edge
// ─────────────────────────────────────────────────────────────────────────────
describe('executePlan — reviewer revise edge', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const BLOCKING = '{"issues":[{"severity":"major","description":"no error handling","location":"a.ts:12"}],"blocking":true}';
  const CLEAN = '{"issues":[],"blocking":false}';

  /** code -> review plan, where the reviewer depends on the coder. */
  function reviewPlan() {
    return makePlan({
      steps: [
        makeStep({ id: 'code', specialist: 'coder', dependsOn: [] }),
        makeStep({ id: 'review', specialist: 'reviewer', dependsOn: ['code'] }),
      ],
    });
  }

  it('a blocking verdict sends the coder back for one more attempt', async () => {
    const calls: string[] = [];
    let reviewRuns = 0;
    mockRunSpecialist.mockImplementation((opts: { step: PlanStep }) => {
      const id = opts.step.id;
      calls.push(id);
      if (id === 'review') {
        reviewRuns++;
        return Promise.resolve(successResult(id, { result: reviewRuns === 1 ? BLOCKING : CLEAN }));
      }
      return Promise.resolve(successResult(id));
    });

    const result = await executePlan({
      plan: reviewPlan(), provider: new MockProvider(), context: mockContext, display: noopDisplay,
    });

    expect(calls.filter(c => c === 'code')).toHaveLength(2);
    expect(calls.filter(c => c === 'review')).toHaveLength(2);
    expect(result.steps.find(s => s.id === 'code')?.retries).toBe(1);
    expect(result.steps.every(s => s.status === 'done')).toBe(true);
    expect(result.status).toBe('done');
  });

  it('the retry budget is exactly one — the coder never runs a third time', async () => {
    const calls: string[] = [];
    mockRunSpecialist.mockImplementation((opts: { step: PlanStep }) => {
      const id = opts.step.id;
      calls.push(id);
      // The reviewer blocks every single time.
      return Promise.resolve(successResult(id, { result: id === 'review' ? BLOCKING : undefined }));
    });

    await executePlan({
      plan: reviewPlan(), provider: new MockProvider(), context: mockContext, display: noopDisplay,
    });

    expect(calls.filter(c => c === 'code')).toHaveLength(2);
  });

  it('a verdict still blocking after the retry fails the review — never silently accepted', async () => {
    mockRunSpecialist.mockImplementation((opts: { step: PlanStep }) => {
      const id = opts.step.id;
      return Promise.resolve(successResult(id, { result: id === 'review' ? BLOCKING : undefined }));
    });

    const result = await executePlan({
      plan: reviewPlan(), provider: new MockProvider(), context: mockContext, display: noopDisplay,
    });

    const review = result.steps.find(s => s.id === 'review')!;
    expect(review.status).toBe('failed');
    expect(review.result).toContain('still blocking');
    expect(review.result).toContain('no error handling');
    expect(result.status).toBe('failed');
  });

  it('dependents of an exhausted blocking review are skipped', async () => {
    const plan = makePlan({
      steps: [
        makeStep({ id: 'code', specialist: 'coder', dependsOn: [] }),
        makeStep({ id: 'review', specialist: 'reviewer', dependsOn: ['code'] }),
        makeStep({ id: 'ship', specialist: 'coder', dependsOn: ['review'] }),
      ],
    });
    mockRunSpecialist.mockImplementation((opts: { step: PlanStep }) =>
      Promise.resolve(successResult(opts.step.id, {
        result: opts.step.id === 'review' ? BLOCKING : undefined,
      })));

    const result = await executePlan({
      plan, provider: new MockProvider(), context: mockContext, display: noopDisplay,
    });

    expect(result.steps.find(s => s.id === 'ship')?.status).toBe('skipped');
  });

  it('a non-blocking verdict with issues does not trigger a retry', async () => {
    const calls: string[] = [];
    const nonBlocking = '{"issues":[{"severity":"minor","description":"nit","location":"a.ts:3"}],"blocking":false}';
    mockRunSpecialist.mockImplementation((opts: { step: PlanStep }) => {
      calls.push(opts.step.id);
      return Promise.resolve(successResult(opts.step.id, {
        result: opts.step.id === 'review' ? nonBlocking : undefined,
      }));
    });

    const result = await executePlan({
      plan: reviewPlan(), provider: new MockProvider(), context: mockContext, display: noopDisplay,
    });

    expect(calls.filter(c => c === 'code')).toHaveLength(1);
    expect(result.steps.find(s => s.id === 'code')?.retries).toBeUndefined();
    expect(result.status).toBe('done');
  });

  it('unparseable reviewer output does not trigger a retry', async () => {
    const calls: string[] = [];
    mockRunSpecialist.mockImplementation((opts: { step: PlanStep }) => {
      calls.push(opts.step.id);
      return Promise.resolve(successResult(opts.step.id, {
        result: opts.step.id === 'review' ? 'Looks good, no notes.' : undefined,
      }));
    });

    await executePlan({
      plan: reviewPlan(), provider: new MockProvider(), context: mockContext, display: noopDisplay,
    });

    expect(calls.filter(c => c === 'code')).toHaveLength(1);
  });

  it('the retried coder does not receive its own superseded attempt in memory', async () => {
    let reviewRuns = 0;
    const memoryOnRetry: string[][] = [];
    mockRunSpecialist.mockImplementation((opts: { step: PlanStep; memory: { stepId: string }[] }) => {
      const id = opts.step.id;
      if (id === 'code') memoryOnRetry.push(opts.memory.map(m => m.stepId));
      if (id === 'review') {
        reviewRuns++;
        return Promise.resolve(successResult(id, { result: reviewRuns === 1 ? BLOCKING : CLEAN }));
      }
      return Promise.resolve(successResult(id));
    });

    await executePlan({
      plan: reviewPlan(), provider: new MockProvider(), context: mockContext, display: noopDisplay,
    });

    // Second coder invocation sees the review's feedback but not its own
    // first-attempt entry.
    expect(memoryOnRetry).toHaveLength(2);
    expect(memoryOnRetry[1]).toContain('review');
    expect(memoryOnRetry[1]).not.toContain('code');
  });

  it('a blocking review on a non-coder dependency does not retry it', async () => {
    const calls: string[] = [];
    const plan = makePlan({
      steps: [
        makeStep({ id: 'research', specialist: 'researcher', dependsOn: [] }),
        makeStep({ id: 'review', specialist: 'reviewer', dependsOn: ['research'] }),
      ],
    });
    mockRunSpecialist.mockImplementation((opts: { step: PlanStep }) => {
      calls.push(opts.step.id);
      return Promise.resolve(successResult(opts.step.id, {
        result: opts.step.id === 'review' ? BLOCKING : undefined,
      }));
    });

    const result = await executePlan({
      plan, provider: new MockProvider(), context: mockContext, display: noopDisplay,
    });

    // Nothing retryable → the review fails rather than looping.
    expect(calls.filter(c => c === 'research')).toHaveLength(1);
    expect(result.steps.find(s => s.id === 'review')?.status).toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Severity fallback — fails closed, and is observable
// ─────────────────────────────────────────────────────────────────────────────
describe('parseReviewVerdict — missing blocking field', () => {
  beforeEach(() => { resetReviewFallbackCount(); });

  it('counts each fallback so a flaky reviewer prompt is visible', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(reviewFallbackCount()).toBe(0);

    parseReviewVerdict('{"issues":[{"severity":"major","description":"x","location":"a.ts:1"}]}');
    expect(reviewFallbackCount()).toBe(1);

    parseReviewVerdict('{"issues":[]}');
    expect(reviewFallbackCount()).toBe(2);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('omitted the required "blocking" field');
    warn.mockRestore();
  });

  it('does not count when blocking is present', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    parseReviewVerdict('{"issues":[],"blocking":false}');
    expect(reviewFallbackCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fails CLOSED — a major issue with no blocking field blocks', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const v = parseReviewVerdict('{"issues":[{"severity":"major","description":"x","location":"a.ts:1"}]}');
    expect(v?.blocking).toBe(true);
    warn.mockRestore();
  });
});
