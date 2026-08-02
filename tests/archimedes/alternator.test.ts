import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LoopResult } from '../../src/agent/loop.js';
import type { LLMProvider } from '../../src/providers/types.js';
import type { ProjectContext } from '../../src/agent/context.js';
import type { ArchimedesConfig } from '../../src/archimedes/types.js';
import { PermissionSystem } from '../../src/safety/permissions.js';

// runAgentLoop is mocked so these tests exercise only ArchimedesAlternator's own
// routing/result-mapping/episode-construction logic, not a real LLM call.
vi.mock('../../src/agent/loop.js', () => ({
  runAgentLoop: vi.fn(),
}));

import { runAgentLoop } from '../../src/agent/loop.js';
import { ArchimedesAlternator } from '../../src/archimedes/alternator.js';

const mockRunAgentLoop = runAgentLoop as unknown as ReturnType<typeof vi.fn>;

function makeLoopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    success: true,
    summary: 'done',
    turns: 1,
    toolCallCount: 0,
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    costUsd: 0.001,
    history: [{ role: 'user', content: 'task' }],
    toolCallLog: [],
    ...overrides,
  };
}

const fakeProvider: LLMProvider = {
  name: 'fake-large',
  model: 'fake-large-model',
  // The large model's only non-streamed call is as Archimedes's answer verifier
  // (verifyArchimedesAnswer). A verifier that returns '' reads as INVALID and
  // forces escalation on every run — so the mock must return an approving
  // verdict for the "Archimedes succeeds" path to be reachable at all.
  complete: async () => ({ text: 'VALID' }),
  stream: async () => makeLoopResult() as any,
} as unknown as LLMProvider;

const fakeContext: ProjectContext = {
  root: '',
  name: 'fake-project',
  language: 'TypeScript',
  framework: '',
  readme: '',
  tree: '',
  config: '',
  recentCommits: '',
};

const enabledArchimedesConfig: ArchimedesConfig = {
  modelName: 'qwen2.5-coder:1.5b',
  ollamaBaseUrl: 'http://localhost:11434/v1',
  competenceThreshold: 0.7,
  minAttempts: 3,
  enabled: true,
  epsilonProbeRate: 0.05,
};

let tmpHome: string;
let origHome: string | undefined;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alternator-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  mockRunAgentLoop.mockReset();
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function baseOpts() {
  return {
    archimedesConfig: enabledArchimedesConfig,
    largeModelProvider: fakeProvider,
    projectRoot: path.join(tmpHome, 'project'),
    context: { ...fakeContext, root: path.join(tmpHome, 'project') },
  };
}

function makeAlternator(archimedesConfig: ArchimedesConfig) {
  return new ArchimedesAlternator({ ...baseOpts(), archimedesConfig });
}

describe('ArchimedesAlternator permission defaulting', () => {
  it('defaults to the safe "normal" permission level when none is provided', () => {
    const alternator = new ArchimedesAlternator(baseOpts());
    // PermissionSystem.level is private; this reaches in deliberately to
    // guard against ever silently reverting to the old hardcoded 'auto'
    // default, which would auto-approve destructive operations during the
    // Archimedes attempt regardless of the user's actual chosen session mode.
    const level = (alternator as any).permissions.level;
    expect(level).toBe('normal');
    expect(level).not.toBe('auto');
  });

  it('uses the caller-provided permission system instead of constructing its own', () => {
    const callerPermissions = new PermissionSystem('read-only');
    const alternator = new ArchimedesAlternator({ ...baseOpts(), permissions: callerPermissions });
    expect((alternator as any).permissions).toBe(callerPermissions);
    expect((alternator as any).permissions.level).toBe('read-only');
  });
});

describe('ArchimedesAlternator.run() — result threading', () => {
  it("returns Archimedes's full LoopResult (not a flattened string) when Archimedes succeeds", async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response); // Ollama reachable
    const archimedesResult = makeLoopResult({ summary: 'archimedes did it', turns: 2, costUsd: 0.0001 });
    mockRunAgentLoop.mockResolvedValueOnce(archimedesResult); // only the Archimedes call should happen

    const alternator = makeAlternator(enabledArchimedesConfig);
    const { loopResult, usedArchimedes, episode } = await alternator.run('fix a small bug');

    expect(usedArchimedes).toBe(true);
    expect(loopResult).toEqual(archimedesResult); // full object identity, not just .summary
    expect(loopResult.turns).toBe(2);
    expect(loopResult.costUsd).toBe(0.0001);
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1); // large model never invoked
    expect(episode.archimedesSucceeded).toBe(true);
    expect(episode.largeModelUsed).toBeUndefined();
  });

  it('escalates to the large model and returns its full LoopResult when Ollama is unreachable', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED')); // Ollama not running
    const largeResult = makeLoopResult({ summary: 'large model did it', turns: 5, costUsd: 0.05 });
    mockRunAgentLoop.mockResolvedValueOnce(largeResult); // only the escalation call happens

    const alternator = makeAlternator(enabledArchimedesConfig);
    const { loopResult, usedArchimedes, episode } = await alternator.run('fix a small bug');

    expect(usedArchimedes).toBe(false);
    expect(loopResult).toEqual(largeResult);
    expect(loopResult.turns).toBe(5);
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expect(episode.archimedesAttempted).toBe(false); // never reached the Archimedes attempt at all
    expect(episode.largeModelUsed).toBe('fake-large-model');
  });

  it('escalates straight to the large model when Archimedes is disabled in config, without pinging Ollama', async () => {
    const largeResult = makeLoopResult({ summary: 'large model only' });
    mockRunAgentLoop.mockResolvedValueOnce(largeResult);

    const alternator = makeAlternator({ ...enabledArchimedesConfig, enabled: false });
    const { loopResult, usedArchimedes, episode } = await alternator.run('fix a small bug');

    expect(usedArchimedes).toBe(false);
    expect(loopResult).toEqual(largeResult);
    expect(fetchSpy).not.toHaveBeenCalled(); // disabled — never even checked Ollama
    expect(episode.archimedesAttempted).toBe(false);
  });

  it('falls back to a safe empty LoopResult — never throws — if both paths fail', async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);
    mockRunAgentLoop
      .mockRejectedValueOnce(new Error('archimedes crashed'))   // Archimedes attempt throws
      .mockRejectedValueOnce(new Error('large model down')); // escalation also throws

    const alternator = makeAlternator(enabledArchimedesConfig);
    const runPromise = alternator.run('fix a small bug');
    await expect(runPromise).resolves.toBeDefined(); // must not throw

    const { loopResult, usedArchimedes } = await runPromise;
    expect(usedArchimedes).toBe(false);
    expect(loopResult.success).toBe(false);
    expect(loopResult.history).toEqual([]);
    expect(loopResult.usage.totalTokens).toBe(0);
  });

  it('passes confirmFn through to runAgentLoop so confirmation prompts work during Archimedes-alternation', async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);
    mockRunAgentLoop.mockResolvedValueOnce(makeLoopResult());
    const confirmFn = vi.fn(async () => true);

    const alternator = new ArchimedesAlternator({ ...baseOpts(), confirmFn });
    await alternator.run('fix a small bug');

    expect(mockRunAgentLoop).toHaveBeenCalledWith(
      expect.objectContaining({ confirmFn }),
    );
  });

  it('passes initialHistory through so multi-turn REPL conversations are not silently reset', async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);
    mockRunAgentLoop.mockResolvedValueOnce(makeLoopResult());
    const priorHistory = [{ role: 'user' as const, content: 'earlier turn' }];

    const alternator = new ArchimedesAlternator({ ...baseOpts(), initialHistory: priorHistory });
    await alternator.run('fix a small bug');

    expect(mockRunAgentLoop).toHaveBeenCalledWith(
      expect.objectContaining({ initialHistory: priorHistory }),
    );
  });
});

describe('ArchimedesAlternator.run() — forceArchimedes (:small1 override)', () => {
  it('attempts Archimedes even when the gate says no (config disabled), and records the attempt', async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);
    const archimedesResult = makeLoopResult({ summary: 'forced archimedes win' });
    mockRunAgentLoop.mockResolvedValueOnce(archimedesResult);

    const alternator = new ArchimedesAlternator({
      ...baseOpts(),
      archimedesConfig: { ...enabledArchimedesConfig, enabled: false },
      forceArchimedes: true,
    });
    const { usedArchimedes, episode, decision } = await alternator.run('fix a small bug');

    expect(decision.useArchimedes).toBe(true);
    expect(decision.reason).toContain('small1');
    expect(usedArchimedes).toBe(true);
    expect(episode.archimedesAttempted).toBe(true); // the forced attempt feeds the competence score
    expect(episode.archimedesSucceeded).toBe(true);
  });

  it('still escalates to the large model when the forced Archimedes attempt fails verification', async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);
    const rejectingProvider = {
      ...fakeProvider,
      complete: async () => ({ text: 'INVALID: wrong answer' }),
    } as unknown as LLMProvider;
    mockRunAgentLoop
      .mockResolvedValueOnce(makeLoopResult({ summary: 'bad archimedes answer' })) // Archimedes attempt
      .mockResolvedValueOnce(makeLoopResult({ summary: 'large model rescue' }));   // escalation

    const alternator = new ArchimedesAlternator({
      ...baseOpts(),
      largeModelProvider: rejectingProvider,
      archimedesConfig: { ...enabledArchimedesConfig, enabled: false },
      forceArchimedes: true,
    });
    const { usedArchimedes, episode, loopResult } = await alternator.run('fix a small bug');

    expect(usedArchimedes).toBe(false);
    expect(loopResult.summary).toBe('large model rescue');
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(2); // verification/escalation NOT disabled by the override
    expect(episode.archimedesAttempted).toBe(true);
    expect(episode.archimedesSucceeded).toBe(false); // the failure still moves the score
  });
});

describe('ArchimedesAlternator — claim-type-aware verification', () => {
  it('REGRESSION: still catches fabrication in retrieval tasks (tool says "not found", answer describes it)', async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);

    // search_code returned "not found" but Archimedes described the function anyway
    const fabricationLoopResult: LoopResult = {
      success: true,
      summary: 'The foo() function handles user authentication by validating tokens...',
      turns: 3,
      toolCallCount: 1,
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300, cachedTokens: 0 },
      costUsd: 0.01,
      history: [
        { role: 'user', content: 'find the foo function' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'search_code', input: { query: 'foo' } }] },
        { role: 'tool_result', results: [{ id: 'call_1', name: 'search_code', content: 'No results found for "foo"' }] },
        { role: 'assistant', content: 'The foo() function handles user authentication...' },
      ],
      toolCallLog: [],
    };

    // Verifier should reject this as INVALID (fabrication)
    const rejectingProvider = {
      ...fakeProvider,
      complete: async () => ({ text: 'INVALID: tool says not found but answer describes it as if it exists' }),
    } as unknown as LLMProvider;

    mockRunAgentLoop.mockResolvedValueOnce(fabricationLoopResult); // Archimedes fabricates
    mockRunAgentLoop.mockResolvedValueOnce(makeLoopResult({ summary: 'large model correct answer' })); // escalation

    const alternator = new ArchimedesAlternator({
      ...baseOpts(),
      largeModelProvider: rejectingProvider,
    });
    const { usedArchimedes, episode, loopResult } = await alternator.run('find the foo function');

    expect(usedArchimedes).toBe(false); // should have escalated
    expect(loopResult.summary).toBe('large model correct answer');
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(2); // Archimedes + large model escalation
    expect(episode.archimedesSucceeded).toBe(false); // verification failed
  });

  it('allows novel proposals in design tasks as long as factual premises are correct', async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);

    // Design task: Archimedes proposes a solution (not in codebase yet) but describes current state correctly
    const designLoopResult: LoopResult = {
      success: true,
      summary: 'The current auth flow uses tokens (confirmed by tools). I propose we add rate limiting by...',
      turns: 4,
      toolCallCount: 2,
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300, cachedTokens: 0 },
      costUsd: 0.01,
      history: [
        { role: 'user', content: 'implement rate limiting for auth' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'search_code', input: { query: 'auth' } }] },
        { role: 'tool_result', results: [{ id: 'call_1', name: 'search_code', content: 'Found auth.ts with token validation logic' }] },
        { role: 'assistant', content: 'The current auth flow uses tokens (confirmed by tools). I propose we add rate limiting by...' },
      ],
      toolCallLog: [],
    };

    // Verifier should accept this as VALID (factual premises are correct, proposal is allowed for design tasks)
    const acceptingProvider = {
      ...fakeProvider,
      complete: async () => ({ text: 'VALID' }),
    } as unknown as LLMProvider;

    mockRunAgentLoop.mockResolvedValueOnce(designLoopResult); // Archimedes proposes design

    const alternator = new ArchimedesAlternator({
      ...baseOpts(),
      largeModelProvider: acceptingProvider,
    });
    const { usedArchimedes, episode } = await alternator.run('implement rate limiting for auth');

    expect(usedArchimedes).toBe(true); // should NOT have escalated
    expect(episode.archimedesSucceeded).toBe(true); // verification passed
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1); // only Archimedes, no escalation
  });

  it('rejects design tasks with fabricated factual premises', async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);

    // Design task with fabricated premise: describes current auth flow that doesn't exist
    const fabricatedDesignLoopResult: LoopResult = {
      success: true,
      summary: 'The current compaction ladder fires at 0.55 (this is wrong per tools). We should add...',
      turns: 3,
      toolCallCount: 1,
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300, cachedTokens: 0 },
      costUsd: 0.01,
      history: [
        { role: 'user', content: 'add a cap to compaction' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'search_code', input: { query: 'compaction' } }] },
        { role: 'tool_result', results: [{ id: 'call_1', name: 'search_code', content: 'No results found for "compaction"' }] },
        { role: 'assistant', content: 'The current compaction ladder fires at 0.55 (this is wrong per tools). We should add...' },
      ],
      toolCallLog: [],
    };

    // Verifier should reject this as INVALID (PART 1 failed: factual premise fabricated)
    const rejectingProvider = {
      ...fakeProvider,
      complete: async () => ({ text: 'INVALID: PART 1 - tool says compaction not found but answer describes it' }),
    } as unknown as LLMProvider;

    mockRunAgentLoop.mockResolvedValueOnce(fabricatedDesignLoopResult);
    mockRunAgentLoop.mockResolvedValueOnce(makeLoopResult({ summary: 'large model correct answer' }));

    const alternator = new ArchimedesAlternator({
      ...baseOpts(),
      largeModelProvider: rejectingProvider,
    });
    const { usedArchimedes, episode } = await alternator.run('add a cap to compaction');

    expect(usedArchimedes).toBe(false); // should have escalated
    expect(episode.archimedesSucceeded).toBe(false); // verification failed
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(2); // Archimedes + large model escalation
  });
});
