import { describe, it, expect, vi } from 'vitest';
import { routeTask, type RouterOptions } from '../../src/orchestration/router.js';
import type { RouterDecision } from '../../src/orchestration/types.js';
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
// Reusable mock LLMProvider — follows the same pattern as FakeProvider in
// tests/loop.test.ts. Call .complete() drains one queued response.
// ─────────────────────────────────────────────────────────────────────────────
class MockRouterProvider implements LLMProvider {
  name = 'MockRouter';
  model = 'mock-router-model';
  supportsTools = false;

  private responses: LLMResponse[];
  public calls: HistoryMessage[] = [];

  constructor(responses: LLMResponse[]) {
    this.responses = [...responses]; // defensive copy
  }

  async complete(
    _system: string,
    history: HistoryMessage[],
    _tools: ToolDefinition[],
  ): Promise<LLMResponse> {
    this.calls.push(...history);
    const next = this.responses.shift();
    if (!next) throw new Error('[MockRouter] No more responses queued');
    return next;
  }

  async *stream(
    _system: string,
    history: HistoryMessage[],
    _tools: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    this.calls.push(...history);
    const next = this.responses.shift();
    if (!next) throw new Error('[MockRouter] No more responses queued');
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
// Response factories
// ─────────────────────────────────────────────────────────────────────────────
function decomposeJSON(overrides: {
  reason?: string;
  confidence?: number;
  estimatedSteps?: number;
} = {}): string {
  return JSON.stringify({
    shouldDecompose: true,
    reason: overrides.reason ?? 'This task spans multiple modules and requires coordinated execution.',
    confidence: overrides.confidence ?? 0.85,
    estimatedSteps: overrides.estimatedSteps ?? 4,
  });
}

function singleAgentJSON(overrides: {
  reason?: string;
  confidence?: number;
} = {}): string {
  return JSON.stringify({
    shouldDecompose: false,
    reason: overrides.reason ?? 'A single agent can handle this straightforward task.',
    confidence: overrides.confidence ?? 0.92,
  });
}

function response(text: string): LLMResponse {
  return { text, toolCalls: [], stopReason: 'done' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: validate RouterDecision shape
// ─────────────────────────────────────────────────────────────────────────────
function assertValidDecision(d: RouterDecision): void {
  expect(d).toBeDefined();
  expect(typeof d.shouldDecompose).toBe('boolean');
  expect(typeof d.reason).toBe('string');
  expect(d.reason.length).toBeGreaterThan(0);
  expect(typeof d.confidence).toBe('number');
  expect(d.confidence).toBeGreaterThanOrEqual(0);
  expect(d.confidence).toBeLessThanOrEqual(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — decompose
// ─────────────────────────────────────────────────────────────────────────────
describe('routeTask — happy path: decompose', () => {
  const baseOpts: Omit<RouterOptions, 'provider' | 'task'> = {
    context: mockContext,
  };

  it('returns shouldDecompose: true for complex multi-module task', async () => {
    const provider = new MockRouterProvider([response(decomposeJSON())]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Add OAuth2 authentication across the auth, API, and database layers',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(true);
    expect(decision.reason).toContain('multiple modules');
  });

  it('returns correct estimatedSteps when provided', async () => {
    const provider = new MockRouterProvider([
      response(decomposeJSON({ estimatedSteps: 5 })),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Refactor the entire core module',
    });

    assertValidDecision(decision);
    expect(decision.estimatedSteps).toBe(5);
  });

  it('rounds fractional estimatedSteps to an integer', async () => {
    const provider = new MockRouterProvider([
      response(decomposeJSON({ estimatedSteps: 3.7 })),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Optimise all database queries',
    });

    expect(decision.estimatedSteps).toBe(4); // Math.round(3.7)
  });

  it('returns confidence between 0 and 1', async () => {
    const provider = new MockRouterProvider([
      response(decomposeJSON({ confidence: 0.73 })),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Rewrite database layer',
    });

    assertValidDecision(decision);
    expect(decision.confidence).toBe(0.73);
  });

  it('returns non-empty reason string', async () => {
    const provider = new MockRouterProvider([
      response(decomposeJSON({ reason: 'Cross-cutting concern affecting 3 subsystems' })),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Update all error handling',
    });

    assertValidDecision(decision);
    expect(decision.reason).toBe('Cross-cutting concern affecting 3 subsystems');
  });

  it('omits estimatedSteps when model does not provide it', async () => {
    const json = JSON.stringify({
      shouldDecompose: true,
      reason: 'multi-module',
      confidence: 0.8,
    });
    const provider = new MockRouterProvider([response(json)]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Big task',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(true);
    expect(decision.estimatedSteps).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — single agent
// ─────────────────────────────────────────────────────────────────────────────
describe('routeTask — happy path: single agent', () => {
  const baseOpts: Omit<RouterOptions, 'provider' | 'task'> = {
    context: mockContext,
  };

  it('returns shouldDecompose: false for simple focused task', async () => {
    const provider = new MockRouterProvider([response(singleAgentJSON())]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Fix typo in README.md',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
    expect(decision.reason).toContain('single agent');
  });

  it('returns confidence between 0 and 1', async () => {
    const provider = new MockRouterProvider([
      response(singleAgentJSON({ confidence: 0.98 })),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Rename variable in utils.ts',
    });

    assertValidDecision(decision);
    expect(decision.confidence).toBe(0.98);
  });

  it('recognises single-file changes as single-agent', async () => {
    const provider = new MockRouterProvider([
      response(singleAgentJSON({
        reason: 'Confined to a single file with no external dependencies',
      })),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Add JSDoc comments to src/logger.ts',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling — provider / parse failures
// ─────────────────────────────────────────────────────────────────────────────
describe('routeTask — error handling: provider / parse failures', () => {
  const baseOpts: Omit<RouterOptions, 'provider' | 'task'> = {
    context: mockContext,
  };

  it('returns shouldDecompose: false when provider returns invalid JSON', async () => {
    const provider = new MockRouterProvider([
      response('{ shouldDecompose: true this is not valid'),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Any task',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
    // Implementation says: "Parse failed — defaulting to single agent"
    expect(decision.reason).toMatch(/parse/i);
  });

  it('returns shouldDecompose: false when provider returns wrong-shape JSON', async () => {
    const provider = new MockRouterProvider([
      response(JSON.stringify({ foo: 'bar', baz: 42 })),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Any task',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
    // shouldDecompose is not a boolean → false; reason not present → "No reason provided"
    expect(decision.reason).toBe('No reason provided');
  });

  it('returns shouldDecompose: false when provider throws', async () => {
    const provider = new MockRouterProvider([]); // no responses queued → throws
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Any task',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
    // Implementation: "Provider error — defaulting to single agent"
    expect(decision.reason).toMatch(/provider/i);
  });

  it('returns shouldDecompose: false when response text is empty', async () => {
    const provider = new MockRouterProvider([response('')]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Any task',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
    // Empty text → JSON.parse('') throws → "Parse failed"
    expect(decision.reason).toMatch(/parse/i);
  });

  it('returns shouldDecompose: false when response text is only whitespace', async () => {
    const provider = new MockRouterProvider([response('   \n  \t  ')]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Any task',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
    // .trim() → '' → JSON.parse('') throws → "Parse failed"
    expect(decision.reason).toMatch(/parse/i);
  });

  it('never throws under any circumstances', async () => {
    // Provider that always throws
    class ThrowingProvider implements LLMProvider {
      name = 'Thrower';
      model = 'thrower';
      supportsTools = false;
      async complete(): Promise<LLMResponse> {
        throw new Error('Provider crashed');
      }
      async *stream(): AsyncGenerator<StreamChunk> {
        throw new Error('Provider crashed');
      }
    }

    await expect(
      routeTask({ context: mockContext, provider: new ThrowingProvider(), task: 'task' }),
    ).resolves.toBeDefined();
    await expect(
      routeTask({ context: mockContext, provider: new ThrowingProvider(), task: '' }),
    ).resolves.toBeDefined();
    await expect(
      routeTask({
        context: mockContext,
        provider: new ThrowingProvider(),
        task: 'task',
        perception: mockPerception,
      }),
    ).resolves.toBeDefined();
  });

  it('handles response that is a JSON array (not an object)', async () => {
    const provider = new MockRouterProvider([response('["a", "b"]')]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Task',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
    // Array is not null, typeof is 'object'... wait, Array.isArray would pass
    // Actually: typeof [] === 'object', and [] !== null, so it passes the check.
    // Then r.shouldDecompose on an array is undefined → false
    // reason is undefined → "No reason provided"
    // confidence is undefined → 0
    expect(decision.reason).toBe('No reason provided');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Confidence clamping
// ─────────────────────────────────────────────────────────────────────────────
describe('routeTask — confidence clamping', () => {
  const baseOpts: Omit<RouterOptions, 'provider' | 'task'> = {
    context: mockContext,
  };

  it('clamps negative confidence to 0', async () => {
    const json = JSON.stringify({ shouldDecompose: true, reason: 'big', confidence: -5 });
    const provider = new MockRouterProvider([response(json)]);
    const decision = await routeTask({ ...baseOpts, provider, task: 'Task' });

    expect(decision.confidence).toBe(0);
  });

  it('clamps confidence above 1 to 1', async () => {
    const json = JSON.stringify({ shouldDecompose: true, reason: 'big', confidence: 9.5 });
    const provider = new MockRouterProvider([response(json)]);
    const decision = await routeTask({ ...baseOpts, provider, task: 'Task' });

    expect(decision.confidence).toBe(1);
  });

  it('defaults non-numeric confidence to 0', async () => {
    const json = JSON.stringify({ shouldDecompose: false, reason: 'ok', confidence: 'high' });
    const provider = new MockRouterProvider([response(json)]);
    const decision = await routeTask({ ...baseOpts, provider, task: 'Task' });

    expect(decision.confidence).toBe(0);
  });

  it('confidence is never NaN', async () => {
    const json = JSON.stringify({ shouldDecompose: false, reason: 'ok' });
    const provider = new MockRouterProvider([response(json)]);
    const decision = await routeTask({ ...baseOpts, provider, task: 'Task' });

    expect(Number.isNaN(decision.confidence)).toBe(false);
  });

  it('confidence is always in [0, 1] for every edge case', async () => {
    const cases = [
      response(JSON.stringify({ shouldDecompose: false, reason: 'r', confidence: 0.5 })),
      response(JSON.stringify({ shouldDecompose: true, reason: 'r', confidence: 1.0 })),
      response(JSON.stringify({ shouldDecompose: true, reason: 'r', confidence: 0.0 })),
      response(JSON.stringify({ shouldDecompose: true, reason: 'r', confidence: -0.1 })),
      response(JSON.stringify({ shouldDecompose: true, reason: 'r', confidence: 1.1 })),
      response('garbage'), // invalid JSON → confidence defaults to 0
      response(''),
    ];

    for (const resp of cases) {
      const provider = new MockRouterProvider([resp]);
      const decision = await routeTask({ ...baseOpts, provider, task: 'Task' });
      expect(decision.confidence).toBeGreaterThanOrEqual(0);
      expect(decision.confidence).toBeLessThanOrEqual(1);
      expect(Number.isNaN(decision.confidence)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reason is always non-empty
// ─────────────────────────────────────────────────────────────────────────────
describe('routeTask — reason is always non-empty', () => {
  const baseOpts: Omit<RouterOptions, 'provider' | 'task'> = {
    context: mockContext,
  };

  it('provides fallback reason when model omits reason field', async () => {
    const json = JSON.stringify({ shouldDecompose: false, confidence: 0.9 });
    const provider = new MockRouterProvider([response(json)]);
    const decision = await routeTask({ ...baseOpts, provider, task: 'Task' });

    expect(decision.reason).toBe('No reason provided');
  });

  it('provides fallback reason when model reason is empty string', async () => {
    const json = JSON.stringify({ shouldDecompose: false, reason: '', confidence: 0.5 });
    const provider = new MockRouterProvider([response(json)]);
    const decision = await routeTask({ ...baseOpts, provider, task: 'Task' });

    // Empty string has length 0 → "No reason provided"
    expect(decision.reason).toBe('No reason provided');
  });

  it('provides fallback reason when provider fails completely', async () => {
    const provider = new MockRouterProvider([]);
    const decision = await routeTask({ ...baseOpts, provider, task: 'Task' });

    // "Provider error — defaulting to single agent"
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.reason).toMatch(/provider/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// With perception
// ─────────────────────────────────────────────────────────────────────────────
describe('routeTask — with perception', () => {
  const baseOpts: Omit<RouterOptions, 'provider' | 'task'> = {
    context: mockContext,
  };

  it('still returns valid RouterDecision when perception is provided', async () => {
    const provider = new MockRouterProvider([
      response(decomposeJSON({
        reason: 'Task touches security-critical auth and legacy db refactor — needs decomposition',
      })),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Add auth to the database layer',
      perception: mockPerception,
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(true);
    expect(decision.reason).toContain('decomposition');
  });

  it('still returns valid RouterDecision when perception is null', async () => {
    const provider = new MockRouterProvider([response(singleAgentJSON())]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Fix a typo',
      perception: null as unknown as ProjectPerception | undefined,
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
  });

  it('still returns valid RouterDecision when perception is undefined', async () => {
    const provider = new MockRouterProvider([response(singleAgentJSON())]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Simple task',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
  });

  it('still handles provider errors even with perception provided', async () => {
    const provider = new MockRouterProvider([
      response('{ not valid json'),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Complex cross-module refactor',
      perception: mockPerception,
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
    expect(decision.reason).toMatch(/parse/i);
  });

  it('still handles provider throws even with perception provided', async () => {
    const provider = new MockRouterProvider([]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Task',
      perception: mockPerception,
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
    expect(decision.reason).toMatch(/provider/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases — empty / whitespace task
// ─────────────────────────────────────────────────────────────────────────────
describe('routeTask — edge case: empty or whitespace task', () => {
  const baseOpts: Omit<RouterOptions, 'provider' | 'task'> = {
    context: mockContext,
  };

  it('handles empty task string gracefully', async () => {
    const provider = new MockRouterProvider([response(decomposeJSON())]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: '',
    });

    assertValidDecision(decision);
  });

  it('handles whitespace-only task string gracefully', async () => {
    const provider = new MockRouterProvider([response(decomposeJSON())]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: '   ',
    });

    assertValidDecision(decision);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Markdown fence stripping
// ─────────────────────────────────────────────────────────────────────────────
describe('routeTask — markdown fence stripping', () => {
  const baseOpts: Omit<RouterOptions, 'provider' | 'task'> = {
    context: mockContext,
  };

  it('strips ```json fences from model response', async () => {
    const provider = new MockRouterProvider([
      response('```json\n' + decomposeJSON() + '\n```'),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Big refactor',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(true);
    expect(decision.reason).toContain('multiple modules');
  });

  it('strips bare ``` fences from model response', async () => {
    const provider = new MockRouterProvider([
      response('```\n' + singleAgentJSON() + '\n```'),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Fix typo',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(false);
  });

  it('strips fences even with trailing whitespace', async () => {
    const provider = new MockRouterProvider([
      response('```json  \n' + decomposeJSON({ estimatedSteps: 2 }) + '\n```  '),
    ]);
    const decision = await routeTask({
      ...baseOpts,
      provider,
      task: 'Refactor',
    });

    assertValidDecision(decision);
    expect(decision.shouldDecompose).toBe(true);
    expect(decision.estimatedSteps).toBe(2);
  });
});
