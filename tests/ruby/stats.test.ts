import { describe, it, expect, beforeEach } from 'vitest';
import { formatStats } from '../../src/ruby/stats.js';
import type { Episode } from '../../src/ruby/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let epCounter = 0;

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  epCounter++;
  return {
    id: `ep-${epCounter}`,
    timestamp: Date.now(),
    task: 'Fix the auth bug',
    projectRoot: '/fake/project',
    rubyAttempted: false,
    rubySucceeded: false,
    largeModelUsed: 'claude-sonnet-4-5',
    reviewerApproved: true,
    tokensUsed: { largeModel: 1000 },
    durationMs: 60_000,
    taskCategory: 'implementation',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// formatStats — empty list
// ─────────────────────────────────────────────────────────────────────────────

describe('formatStats — empty episode list', () => {
  it('returns a string', () => {
    expect(typeof formatStats([])).toBe('string');
  });

  it('shows zero episodes', () => {
    const output = formatStats([]);
    expect(output).toContain('Episodes recorded:  0');
  });

  it('shows 0% completion', () => {
    const output = formatStats([]);
    expect(output).toContain('Tasks completed:    0 (0%)');
  });

  it('shows em dash for avg duration when no episodes', () => {
    const output = formatStats([]);
    expect(output).toContain('Avg duration:       —');
  });

  it('shows em dash for top model when no episodes', () => {
    const output = formatStats([]);
    expect(output).toContain('Top model:          —');
  });

  it('shows zero tokens when no episodes', () => {
    const output = formatStats([]);
    expect(output).toContain('Total tokens used:  0');
  });

  it('includes the Aura Stats header', () => {
    const output = formatStats([]);
    expect(output).toContain('Aura Stats');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatStats — single episode
// ─────────────────────────────────────────────────────────────────────────────

describe('formatStats — single episode', () => {
  beforeEach(() => { epCounter = 0; });

  it('counts 1 episode', () => {
    const output = formatStats([makeEpisode()]);
    expect(output).toContain('Episodes recorded:  1');
  });

  it('counts completed task when reviewerApproved=true', () => {
    const output = formatStats([makeEpisode({ reviewerApproved: true })]);
    expect(output).toContain('Tasks completed:    1 (100%)');
  });

  it('counts 0 completed when reviewerApproved=false', () => {
    const output = formatStats([makeEpisode({ reviewerApproved: false })]);
    expect(output).toContain('Tasks completed:    0 (0%)');
  });

  it('formats duration correctly — seconds only', () => {
    const output = formatStats([makeEpisode({ durationMs: 30_000 })]);
    expect(output).toContain('30s');
  });

  it('formats duration correctly — minutes and seconds', () => {
    const output = formatStats([makeEpisode({ durationMs: 134_000 })]);
    // 134s = 2m 14s
    expect(output).toContain('2m 14s');
  });

  it('shows the large model as top model', () => {
    const output = formatStats([makeEpisode({ largeModelUsed: 'deepseek-v4-flash' })]);
    expect(output).toContain('deepseek-v4-flash');
  });

  it('shows token count for single episode', () => {
    const output = formatStats([makeEpisode({ tokensUsed: { largeModel: 500 } })]);
    expect(output).toContain('500');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatStats — multiple episodes with mixed success
// ─────────────────────────────────────────────────────────────────────────────

describe('formatStats — multiple episodes with mixed success', () => {
  beforeEach(() => { epCounter = 0; });

  it('counts total episodes', () => {
    const episodes = [
      makeEpisode({ reviewerApproved: true }),
      makeEpisode({ reviewerApproved: false }),
      makeEpisode({ reviewerApproved: true }),
    ];
    const output = formatStats(episodes);
    expect(output).toContain('Episodes recorded:  3');
  });

  it('counts only approved as completed', () => {
    const episodes = [
      makeEpisode({ reviewerApproved: true }),
      makeEpisode({ reviewerApproved: false }),
      makeEpisode({ reviewerApproved: true }),
    ];
    const output = formatStats(episodes);
    expect(output).toContain('Tasks completed:    2 (67%)');
  });

  it('picks the most-used model as top model', () => {
    const episodes = [
      makeEpisode({ largeModelUsed: 'claude-sonnet-4-5', reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'claude-sonnet-4-5', reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'gpt-4o', reviewerApproved: false }),
    ];
    const output = formatStats(episodes);
    expect(output).toContain('claude-sonnet-4-5');
    // Should show 2 tasks for the top model
    expect(output).toContain('2 tasks');
  });

  it('shows success percentage in top model line', () => {
    const episodes = [
      makeEpisode({ largeModelUsed: 'deepseek-v4', reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'deepseek-v4', reviewerApproved: false }),
    ];
    const output = formatStats(episodes);
    // 1 out of 2 approved = 50% success
    expect(output).toContain('50% success');
  });

  it('accumulates token counts across episodes', () => {
    const episodes = [
      makeEpisode({ tokensUsed: { largeModel: 500_000 } }),
      makeEpisode({ tokensUsed: { largeModel: 600_000 } }),
    ];
    const output = formatStats(episodes);
    // 1.1M total
    expect(output).toContain('1.1M');
  });

  it('averages duration across episodes', () => {
    const episodes = [
      makeEpisode({ durationMs: 60_000 }),   // 1m 0s
      makeEpisode({ durationMs: 120_000 }),  // 2m 0s
    ];
    const output = formatStats(episodes);
    // avg = 90s = 1m 30s
    expect(output).toContain('1m 30s');
  });

  it('handles episodes with no largeModelUsed gracefully', () => {
    const episodes = [
      makeEpisode({ largeModelUsed: undefined, rubySucceeded: true, reviewerApproved: true }),
      makeEpisode({ largeModelUsed: 'claude-sonnet-4-5', reviewerApproved: true }),
    ];
    expect(() => formatStats(episodes)).not.toThrow();
    const output = formatStats(episodes);
    expect(output).toContain('Episodes recorded:  2');
  });

  it('formats large token counts with K/M suffix', () => {
    const episodes = [makeEpisode({ tokensUsed: { largeModel: 2_500_000 } })];
    const output = formatStats(episodes);
    expect(output).toContain('2.5M');
  });

  it('formats token counts under 1M with K suffix', () => {
    const episodes = [makeEpisode({ tokensUsed: { largeModel: 340_000 } })];
    const output = formatStats(episodes);
    expect(output).toContain('340.0K');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatStats — edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('formatStats — edge cases', () => {
  it('never throws on malformed episodes', () => {
    // Partial episode with missing fields
    const bad = [{ id: 'x', timestamp: 0 } as unknown as Episode];
    expect(() => formatStats(bad)).not.toThrow();
  });

  it('handles zero durationMs gracefully', () => {
    const output = formatStats([makeEpisode({ durationMs: 0 })]);
    expect(output).toContain('Avg duration:');
  });

  it('singular task label in top model line', () => {
    const output = formatStats([makeEpisode({ largeModelUsed: 'my-model' })]);
    expect(output).toContain('1 task,');
  });
});
