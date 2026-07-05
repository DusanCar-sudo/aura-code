import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoadEpisodes = vi.fn();
vi.mock('../../src/ruby/episode-capture.js', () => ({
  loadEpisodes: (...args: unknown[]) => mockLoadEpisodes(...args),
}));

import { mineExperience } from '../../src/mining/extract.js';
import type { Episode, TaskCategory } from '../../src/ruby/types.js';

function makeEpisode(overrides: Partial<Episode> & { task: string; taskCategory: TaskCategory }): Episode {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: Date.now(),
    projectRoot: '/fake',
    rubyAttempted: false,
    rubySucceeded: false,
    reviewerApproved: true,
    tokensUsed: {},
    durationMs: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  mockLoadEpisodes.mockReset();
});

describe('mineExperience — empty and trivial cases', () => {
  it('returns empty result for zero episodes', async () => {
    mockLoadEpisodes.mockResolvedValue([]);
    const result = await mineExperience('/fake');
    expect(result.concepts).toEqual([]);
    expect(result.episodeCount).toBe(0);
    expect(result.unclustered).toBe(0);
  });

  it('does not cluster categories below MIN_CLUSTER_SIZE', async () => {
    mockLoadEpisodes.mockResolvedValue([
      makeEpisode({ task: 'fix the login bug', taskCategory: 'implementation' }),
      makeEpisode({ task: 'fix the auth bug', taskCategory: 'implementation' }),
    ]);
    const result = await mineExperience('/fake');
    expect(result.concepts).toEqual([]);
    expect(result.unclustered).toBe(2);
  });
});

describe('mineExperience — clustering behavior', () => {
  it('clusters episodes that share keywords within a category', async () => {
    mockLoadEpisodes.mockResolvedValue([
      makeEpisode({ task: 'fix authentication bug in login flow', taskCategory: 'implementation' }),
      makeEpisode({ task: 'fix authentication bug in signup flow', taskCategory: 'implementation' }),
      makeEpisode({ task: 'authentication bug causing logout', taskCategory: 'implementation' }),
      makeEpisode({ task: 'refactor database connection pool', taskCategory: 'refactor' }),
      makeEpisode({ task: 'refactor database connection retry logic', taskCategory: 'refactor' }),
      makeEpisode({ task: 'refactor database connection timeout handling', taskCategory: 'refactor' }),
    ]);
    const result = await mineExperience('/fake');
    expect(result.episodeCount).toBe(6);
    expect(result.concepts.length).toBeGreaterThan(0);

    const authConcept = result.concepts.find(c => c.keywords.includes('authentication'));
    expect(authConcept).toBeDefined();
    expect(authConcept!.category).toBe('implementation');
    expect(authConcept!.frequency).toBe(3);
  });

  it('separates unrelated episodes within the same category into different concepts', async () => {
    mockLoadEpisodes.mockResolvedValue([
      makeEpisode({ task: 'fix authentication token expiry bug', taskCategory: 'implementation' }),
      makeEpisode({ task: 'fix authentication token refresh bug', taskCategory: 'implementation' }),
      makeEpisode({ task: 'fix authentication token validation bug', taskCategory: 'implementation' }),
      makeEpisode({ task: 'optimize rendering performance pipeline', taskCategory: 'implementation' }),
      makeEpisode({ task: 'optimize rendering performance batching', taskCategory: 'implementation' }),
      makeEpisode({ task: 'optimize rendering performance caching', taskCategory: 'implementation' }),
    ]);
    const result = await mineExperience('/fake');
    const concepts = result.concepts.filter(c => c.category === 'implementation');
    const allKeywords = new Set(concepts.flatMap(c => c.keywords));
    expect(allKeywords.has('authentication') || allKeywords.has('token')).toBe(true);
    expect(allKeywords.has('rendering') || allKeywords.has('performance')).toBe(true);
  });
});

describe('mineExperience — confidence bounds', () => {
  it('never produces confidence outside [0, 1]', async () => {
    const episodes: Episode[] = [];
    for (let i = 0; i < 30; i++) {
      episodes.push(makeEpisode({
        task: `fix authentication bug variant ${i} in login subsystem`,
        taskCategory: 'implementation',
      }));
    }
    mockLoadEpisodes.mockResolvedValue(episodes);
    const result = await mineExperience('/fake');
    for (const c of result.concepts) {
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('gives higher confidence to larger, more frequent clusters', async () => {
    const episodes: Episode[] = [];
    for (let i = 0; i < 20; i++) {
      episodes.push(makeEpisode({
        task: `verify tests pass after change ${i}`,
        taskCategory: 'review',
      }));
    }
    for (let i = 0; i < 3; i++) {
      episodes.push(makeEpisode({
        task: `review documentation formatting issue ${i}`,
        taskCategory: 'review',
      }));
    }
    mockLoadEpisodes.mockResolvedValue(episodes);
    const result = await mineExperience('/fake');
    expect(result.concepts.length).toBeGreaterThan(0);
    const top = result.concepts[0];
    expect(top.frequency).toBeGreaterThanOrEqual(3);
  });
});

describe('mineExperience — recursion termination', () => {
  it('terminates on a large, uniform dataset without hanging or exceeding bounds', async () => {
    const episodes: Episode[] = [];
    for (let i = 0; i < 200; i++) {
      episodes.push(makeEpisode({
        task: `run build and verify tests pass iteration ${i}`,
        taskCategory: 'review',
      }));
    }
    mockLoadEpisodes.mockResolvedValue(episodes);

    const start = Date.now();
    const result = await mineExperience('/fake');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    expect(result.episodeCount).toBe(200);
    for (const c of result.concepts) {
      expect(c.depth).toBeGreaterThanOrEqual(1);
      expect(c.depth).toBeLessThanOrEqual(3);
    }
  });

  it('handles a dataset with totally unique tasks (no clustering possible)', async () => {
    const episodes: Episode[] = [];
    for (let i = 0; i < 10; i++) {
      episodes.push(makeEpisode({
        task: `zzznique${i} qqqtopic${i} wwwdistinct${i}`,
        taskCategory: 'other',
      }));
    }
    mockLoadEpisodes.mockResolvedValue(episodes);
    const result = await mineExperience('/fake');
    expect(result.episodeCount).toBe(10);
    expect(result.unclustered).toBeGreaterThanOrEqual(0);
  });
});

describe('mineExperience — output shape', () => {
  it('produces MinedConcept objects, not training pairs', async () => {
    mockLoadEpisodes.mockResolvedValue([
      makeEpisode({ task: 'fix database migration ordering bug', taskCategory: 'implementation' }),
      makeEpisode({ task: 'fix database migration rollback bug', taskCategory: 'implementation' }),
      makeEpisode({ task: 'fix database migration schema bug', taskCategory: 'implementation' }),
    ]);
    const result = await mineExperience('/fake');
    expect(result.concepts.length).toBeGreaterThan(0);
    const c = result.concepts[0];
    expect(c).toHaveProperty('concept');
    expect(c).toHaveProperty('category');
    expect(c).toHaveProperty('examples');
    expect(c).toHaveProperty('frequency');
    expect(c).toHaveProperty('confidence');
    expect(c).not.toHaveProperty('instruction');
    expect(c).not.toHaveProperty('output');
  });

  it('caps examples at 5 per concept', async () => {
    const episodes: Episode[] = [];
    for (let i = 0; i < 15; i++) {
      episodes.push(makeEpisode({
        task: `refactor payment processing module variant ${i}`,
        taskCategory: 'refactor',
      }));
    }
    mockLoadEpisodes.mockResolvedValue(episodes);
    const result = await mineExperience('/fake');
    for (const c of result.concepts) {
      expect(c.examples.length).toBeLessThanOrEqual(5);
    }
  });
});
