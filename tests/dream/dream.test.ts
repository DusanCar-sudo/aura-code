import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Episode } from '../../src/archimedes/types.js';
import type { LLMProvider, LLMResponse } from '../../src/providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock the two external dependencies of the dream module:
//   - loadEpisodes (episode source)
//   - createProvider / checkOllamaHealth (the Ollama fallback path)
// Everything else (fs, prompt building, state file) runs for real against a
// tmp dir so we exercise the actual write/cutoff logic.
// ─────────────────────────────────────────────────────────────────────────────
const loadEpisodesMock = vi.fn();
vi.mock('../../src/archimedes/episode-capture.js', () => ({
  loadEpisodes: (...args: unknown[]) => loadEpisodesMock(...args),
}));

const checkOllamaHealthMock = vi.fn();
const createProviderMock = vi.fn();
vi.mock('../../src/providers/factory.js', () => ({
  checkOllamaHealth: (...args: unknown[]) => checkOllamaHealthMock(...args),
  createProvider: (...args: unknown[]) => createProviderMock(...args),
}));

// Import AFTER mocks are registered.
import { runDream, lastDreamTimestamp } from '../../src/dream/dream.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────
function makeEpisode(over: Partial<Episode> = {}): Episode {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    timestamp: over.timestamp ?? 1000,
    task: over.task ?? 'add a null check to the parser',
    projectRoot: over.projectRoot ?? '/tmp/proj',
    archimedesAttempted: over.archimedesAttempted ?? true,
    archimedesSucceeded: over.archimedesSucceeded ?? true,
    archimedesOutput: over.archimedesOutput,
    largeModelUsed: over.largeModelUsed,
    largeModelOutput: over.largeModelOutput,
    reviewerApproved: over.reviewerApproved ?? true,
    tokensUsed: over.tokensUsed ?? { archimedes: 100 },
    durationMs: over.durationMs ?? 4200,
    taskCategory: over.taskCategory ?? 'implementation',
  };
}

/** A provider whose complete() returns canned text (or throws if given an Error). */
function fakeProvider(result: string | Error): LLMProvider {
  return {
    name: 'Fake',
    model: 'fake-model',
    supportsTools: false,
    async complete(): Promise<LLMResponse> {
      if (result instanceof Error) throw result;
      return { text: result, toolCalls: [], stopReason: 'done' };
    },
    async *stream() { /* unused */ },
  } as LLMProvider;
}

const GOOD_BODY =
  '## Lessons\n- [routing] archimedes handles small null-check edits fine\n\n' +
  '## Patterns\n- recurring parser tweaks\n\n' +
  '## Open threads\n- none\n\n' +
  '## Tomorrow brief\nReady for more parser work.';

describe('runDream', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-dream-'));
    loadEpisodesMock.mockReset();
    checkOllamaHealthMock.mockReset();
    createProviderMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('skips cleanly on an empty day and writes nothing', async () => {
    loadEpisodesMock.mockResolvedValue([]);

    const res = await runDream({ projectRoot, provider: fakeProvider(GOOD_BODY) });

    expect(res.skipped).toBe(true);
    expect(res.episodeCount).toBe(0);
    expect(res.reason).toMatch(/no new episodes/i);
    expect(fs.existsSync(path.join(projectRoot, 'dreams'))).toBe(false);
  });

  it('consolidates, writes a dated markdown file, and advances the cutoff', async () => {
    const eps = [
      makeEpisode({ timestamp: 1000 }),
      makeEpisode({ timestamp: 5000, taskCategory: 'refactor' }),
    ];
    loadEpisodesMock.mockResolvedValue(eps);

    const res = await runDream({ projectRoot, provider: fakeProvider(GOOD_BODY) });

    expect(res.skipped).toBe(false);
    expect(res.episodeCount).toBe(2);
    expect(res.path).toMatch(/dreams[/\\]\d{4}-\d{2}-\d{2}\.md$/);

    const md = fs.readFileSync(res.path, 'utf8');
    expect(md).toContain('# Dream —');
    expect(md).toContain('2 episodes recalled');
    expect(md).toContain('## Lessons');
    // Categories from both episodes appear in the header.
    expect(md).toContain('implementation');
    expect(md).toContain('refactor');

    // Cutoff advanced to the NEWEST episode timestamp.
    expect(lastDreamTimestamp(projectRoot)).toBe(5000);
  });

  it('only recalls episodes newer than the cutoff', async () => {
    const eps = [
      makeEpisode({ timestamp: 500 }),   // before cutoff → excluded
      makeEpisode({ timestamp: 1500 }),  // after cutoff  → included
      makeEpisode({ timestamp: 2500 }),  // after cutoff  → included
    ];
    loadEpisodesMock.mockResolvedValue(eps);

    const res = await runDream({ projectRoot, provider: fakeProvider(GOOD_BODY), since: 1000 });

    expect(res.episodeCount).toBe(2);
    expect(res.recalledSince).toBe(1000);
    expect(lastDreamTimestamp(projectRoot)).toBe(2500);
  });

  it('full:true ignores the cutoff and consolidates everything', async () => {
    const eps = [makeEpisode({ timestamp: 10 }), makeEpisode({ timestamp: 20 })];
    loadEpisodesMock.mockResolvedValue(eps);

    const res = await runDream({ projectRoot, provider: fakeProvider(GOOD_BODY), since: 999_999, full: true });

    expect(res.skipped).toBe(false);
    expect(res.episodeCount).toBe(2);
    expect(res.recalledSince).toBe(0);
  });

  // ── The critical invariant: episodes are NEVER burned on provider failure ──
  it('preserves episodes and does NOT advance the cutoff when the provider fails (no ollama)', async () => {
    loadEpisodesMock.mockResolvedValue([makeEpisode({ timestamp: 7000 })]);

    const res = await runDream({
      projectRoot,
      provider: fakeProvider(new Error('HTTP 402 Payment Required')),
      ollamaFallbackModel: false, // disable the fallback for this case
    });

    expect(res.skipped).toBe(true);
    expect(res.providerError).toMatch(/402/);
    expect(res.episodeCount).toBe(1);
    // No file written and cutoff untouched → next :dream re-recalls these episodes.
    expect(lastDreamTimestamp(projectRoot)).toBe(0);
    expect(fs.existsSync(path.join(projectRoot, 'dreams'))).toBe(false);
  });

  it('treats an empty provider response as a failure (episodes preserved)', async () => {
    loadEpisodesMock.mockResolvedValue([makeEpisode({ timestamp: 8000 })]);

    const res = await runDream({
      projectRoot,
      provider: fakeProvider('   '), // whitespace-only → empty after trim
      ollamaFallbackModel: false,
    });

    expect(res.skipped).toBe(true);
    expect(res.providerError).toMatch(/empty/i);
    expect(lastDreamTimestamp(projectRoot)).toBe(0);
  });

  // ── Ollama fallback path ────────────────────────────────────────────────────
  it('falls back to Ollama when the primary fails, then writes and advances', async () => {
    loadEpisodesMock.mockResolvedValue([makeEpisode({ timestamp: 9000 })]);
    checkOllamaHealthMock.mockResolvedValue(true);
    createProviderMock.mockReturnValue(fakeProvider(GOOD_BODY));

    const res = await runDream({
      projectRoot,
      provider: fakeProvider(new Error('primary down')),
      ollamaFallbackModel: 'llama3.2',
    });

    expect(createProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'ollama/llama3.2', maxTokens: 2048 }),
    );
    expect(res.skipped).toBe(false);
    expect(res.providerError).toBeUndefined();
    expect(lastDreamTimestamp(projectRoot)).toBe(9000);
  });

  it('reports both errors and preserves episodes when ollama is unreachable', async () => {
    loadEpisodesMock.mockResolvedValue([makeEpisode({ timestamp: 9500 })]);
    checkOllamaHealthMock.mockResolvedValue(false);

    const res = await runDream({
      projectRoot,
      provider: fakeProvider(new Error('primary boom')),
      ollamaFallbackModel: 'llama3.2',
    });

    expect(res.skipped).toBe(true);
    expect(res.providerError).toMatch(/primary boom/);
    expect(res.providerError).toMatch(/Ollama not reachable/i);
    expect(createProviderMock).not.toHaveBeenCalled();
    expect(lastDreamTimestamp(projectRoot)).toBe(0);
  });
});
