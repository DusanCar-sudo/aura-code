import { describe, it, expect, beforeEach } from 'vitest';
import { selectModelFromHistory } from '../../src/archimedes/model-selector.js';
import type { Episode } from '../../src/archimedes/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let epCounter = 0;

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  epCounter++;
  return {
    id: `ep-${epCounter}`,
    timestamp: Date.now(),
    task: 'Fix the auth bug in core/auth.ts',
    projectRoot: '/fake/project',
    archimedesAttempted: false,
    archimedesSucceeded: false,
    largeModelUsed: 'claude-sonnet-4-5',
    reviewerApproved: true,
    tokensUsed: { largeModel: 1000 },
    durationMs: 5000,
    taskCategory: 'implementation',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// selectModelFromHistory — not enough episodes
// ─────────────────────────────────────────────────────────────────────────────

describe('selectModelFromHistory — insufficient history', () => {
  it('returns undefined when fewer than 5 episodes', () => {
    const episodes = [makeEpisode(), makeEpisode(), makeEpisode()];
    const result = selectModelFromHistory(episodes, 'fix bug', ['claude-sonnet-4-5']);
    expect(result).toBeUndefined();
  });

  it('returns undefined when episode list is empty', () => {
    const result = selectModelFromHistory([], 'fix bug', ['claude-sonnet-4-5']);
    expect(result).toBeUndefined();
  });

  it('returns undefined when availableModels is empty', () => {
    const episodes = Array.from({ length: 6 }, () => makeEpisode());
    const result = selectModelFromHistory(episodes, 'fix bug', []);
    expect(result).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectModelFromHistory — model selection
// ─────────────────────────────────────────────────────────────────────────────

describe('selectModelFromHistory — model selection', () => {
  beforeEach(() => { epCounter = 0; });

  it('selects the only available model when it appears in history', () => {
    const episodes = Array.from({ length: 5 }, () =>
      makeEpisode({ largeModelUsed: 'claude-sonnet-4-5', reviewerApproved: true }),
    );
    const result = selectModelFromHistory(episodes, 'fix auth bug', ['claude-sonnet-4-5']);
    expect(result).toBe('claude-sonnet-4-5');
  });

  it('ignores models not in availableModels list', () => {
    const episodes = Array.from({ length: 5 }, () =>
      makeEpisode({ largeModelUsed: 'some-unknown-model', reviewerApproved: true }),
    );
    const result = selectModelFromHistory(episodes, 'fix bug', ['claude-sonnet-4-5']);
    expect(result).toBeUndefined();
  });

  it('prefers model with higher approval rate', () => {
    // 3 episodes with modelA (all approved) + 3 with modelB (none approved)
    const episodes = [
      makeEpisode({ largeModelUsed: 'modelA', reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'modelA', reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'modelA', reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'modelB', reviewerApproved: false }),
      makeEpisode({ largeModelUsed: 'modelB', reviewerApproved: false }),
      makeEpisode({ largeModelUsed: 'modelB', reviewerApproved: false }),
    ];
    const result = selectModelFromHistory(episodes, 'fix bug', ['modelA', 'modelB']);
    expect(result).toBe('modelA');
  });

  it('falls back to task count when approval rates are equal', () => {
    // modelA: 4 tasks all approved; modelB: 2 tasks all approved
    const episodes = [
      makeEpisode({ largeModelUsed: 'modelA', reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'modelA', reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'modelA', reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'modelA', reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'modelB', reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'modelB', reviewerApproved: true }),
    ];
    const result = selectModelFromHistory(episodes, 'fix bug', ['modelA', 'modelB']);
    expect(result).toBe('modelA');
  });

  it('ignores episodes without largeModelUsed', () => {
    const episodes = [
      makeEpisode({ largeModelUsed: undefined, archimedesSucceeded: true }),
      makeEpisode({ largeModelUsed: undefined, archimedesSucceeded: true }),
      makeEpisode({ largeModelUsed: undefined, archimedesSucceeded: true }),
      makeEpisode({ largeModelUsed: 'claude-sonnet-4-5', reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'claude-sonnet-4-5', reviewerApproved: true }),
    ];
    const result = selectModelFromHistory(
      episodes,
      'fix bug',
      ['claude-sonnet-4-5'],
    );
    expect(result).toBe('claude-sonnet-4-5');
  });

  it('never throws on invalid input', () => {
    expect(() =>
      selectModelFromHistory(null as unknown as Episode[], 'task', ['m']),
    ).not.toThrow();
    expect(() =>
      selectModelFromHistory([makeEpisode(), makeEpisode(), makeEpisode(), makeEpisode(), makeEpisode()], null as unknown as string, ['m']),
    ).not.toThrow();
  });

  it('returns a model string when selection succeeds', () => {
    const episodes = Array.from({ length: 5 }, () =>
      makeEpisode({ largeModelUsed: 'deepseek-v4', reviewerApproved: true }),
    );
    const result = selectModelFromHistory(episodes, 'add feature', ['deepseek-v4']);
    expect(typeof result).toBe('string');
    expect(result).toBe('deepseek-v4');
  });
});
