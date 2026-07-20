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
