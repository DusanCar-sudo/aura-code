import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockLoadEpisodes = vi.fn();
vi.mock('../../src/archimedes/episode-capture.js', () => ({
  loadEpisodes: (...args: unknown[]) => mockLoadEpisodes(...args),
}));

import { correctionFromEpisode, collectCorrections } from '../../src/mining/corrections.js';
import type { Episode } from '../../src/archimedes/types.js';

function makeEpisode(overrides: Partial<Episode>): Episode {
  return {
    id: 'ep-1',
    timestamp: 1700000000000,
    task: 'fix the login bug',
    projectRoot: '/fake',
    archimedesAttempted: true,
    archimedesSucceeded: false,
    archimedesOutput: 'I think we should add a new table.',
    largeModelUsed: 'deepseek-chat',
    largeModelOutput: 'The bug is an off-by-one in the pagination slice.',
    reviewerApproved: true,
    tokensUsed: { archimedes: 100, largeModel: 500 },
    durationMs: 1000,
    taskCategory: 'implementation',
    ...overrides,
  };
}

beforeEach(() => {
  mockLoadEpisodes.mockReset();
});

describe('correctionFromEpisode — selects escalation episodes', () => {
  it('returns a correction pair for a normal escalation episode', () => {
    const ex = correctionFromEpisode(makeEpisode({}));
    expect(ex).not.toBeNull();
    expect(ex!.instruction).toBe('fix the login bug');
    expect(ex!.output).toContain('off-by-one');
    expect(ex!.input).toContain('What Archimedes (small model) produced');
    expect(ex!.metadata.provenance).toBe('correction');
    expect(ex!.metadata.taskCategory).toBe('implementation');
  });

  it('skips episodes where Archimedes was not attempted', () => {
    expect(correctionFromEpisode(makeEpisode({ archimedesAttempted: false }))).toBeNull();
  });

  it('skips episodes where Archimedes succeeded', () => {
    expect(correctionFromEpisode(makeEpisode({ archimedesSucceeded: true }))).toBeNull();
  });

  it('skips episodes with no large-model output', () => {
    expect(correctionFromEpisode(makeEpisode({ largeModelOutput: '' }))).toBeNull();
    expect(correctionFromEpisode(makeEpisode({ largeModelOutput: undefined }))).toBeNull();
  });

  it('skips episodes with empty task', () => {
    expect(correctionFromEpisode(makeEpisode({ task: '  ' }))).toBeNull();
  });

  it('includes Archimedes output in input even when brief', () => {
    const ex = correctionFromEpisode(makeEpisode({ archimedesOutput: 'just a guess' }));
    expect(ex!.input).toContain('just a guess');
  });
});

describe('collectCorrections — appends to training-data/', () => {
  it('writes only escalation episodes as provenance "correction" rows', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-corr-'));
    mockLoadEpisodes.mockResolvedValue([
      makeEpisode({ id: 'a', archimedesAttempted: true, archimedesSucceeded: false, largeModelOutput: 'answer A' }),
      makeEpisode({ id: 'b', archimedesAttempted: true, archimedesSucceeded: true, largeModelOutput: 'answer B' }),
      makeEpisode({ id: 'c', archimedesAttempted: false, largeModelOutput: 'answer C' }),
    ]);
    const res = await collectCorrections(root);
    expect(res.written.length).toBe(1);
    expect(res.skipped).toBe(2);
    expect(res.outputPath).toContain('training-data/');
    expect(res.written[0].metadata.provenance).toBe('correction');
  });

  it('returns empty result when no episodes exist', async () => {
    mockLoadEpisodes.mockResolvedValue([]);
    const res = await collectCorrections('/fake');
    expect(res.written).toEqual([]);
    expect(res.skipped).toBe(0);
    expect(res.outputPath).toBeUndefined();
  });
});
