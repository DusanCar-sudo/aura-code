import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The store resolves its path from the home directory at call time, so each
// test gets a throwaway HOME rather than touching the real memory.
let tmp: string;
let realHome: string | undefined;

async function mem(): Promise<typeof import('../src/agent/episodic-memory.js')> {
  return import('../src/agent/episodic-memory.js');
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-epi-'));
  process.env.HOME = tmp;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('episodic memory', () => {
  it('starts empty', async () => {
    const { loadEpisodes, searchEpisodes } = await mem();
    expect(loadEpisodes()).toEqual([]);
    expect(searchEpisodes('anything')).toEqual([]);
  });

  it('records and finds an episode by a distinctive word', async () => {
    const { addEpisode, searchEpisodes } = await mem();
    addEpisode({ kind: 'memo', text: 'Idea for a kayak rental booking app with tides' });
    addEpisode({ kind: 'memo', text: 'Remember to renew the domain next month' });

    const hits = searchEpisodes('kayak');
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('kayak');
  });

  it('is idempotent by id, so a re-sync does not duplicate', async () => {
    const { addEpisode, loadEpisodes } = await mem();
    addEpisode({ id: 'memo-1', kind: 'memo', text: 'first thought' });
    addEpisode({ id: 'memo-1', kind: 'memo', text: 'first thought' });

    // Phones retry; the same memo appearing three times in recall is worse
    // than it appearing none.
    expect(loadEpisodes()).toHaveLength(1);
  });

  it('ranks a rare term above a common one', async () => {
    const { addEpisode, searchEpisodes } = await mem();
    for (let i = 0; i < 8; i++) {
      addEpisode({ kind: 'memo', text: `the project needs work item ${i}` });
    }
    addEpisode({ kind: 'memo', text: 'the project needs a heliostat' });

    const hits = searchEpisodes('project heliostat');
    // "project" is in every episode and should contribute almost nothing.
    expect(hits[0].text).toContain('heliostat');
  });

  it('weighs a title match above a body match', async () => {
    const { addEpisode, searchEpisodes } = await mem();
    addEpisode({ kind: 'memo', title: 'Unrelated', text: 'mentions falconry once' });
    addEpisode({ kind: 'memo', title: 'Falconry plan', text: 'body text without the word' });

    expect(searchEpisodes('falconry')[0].title).toBe('Falconry plan');
  });

  it('prefers episodes matching every term', async () => {
    const { addEpisode, searchEpisodes } = await mem();
    addEpisode({ kind: 'memo', text: 'bicycle maintenance notes' });
    addEpisode({ kind: 'memo', text: 'bicycle courier scheduling app' });

    const hits = searchEpisodes('bicycle courier');
    expect(hits[0].text).toContain('courier');
  });

  it('breaks ties by recency', async () => {
    const { addEpisode, searchEpisodes } = await mem();
    addEpisode({ kind: 'memo', text: 'sailing idea', at: '2020-01-01T00:00:00.000Z' });
    addEpisode({ kind: 'memo', text: 'sailing idea', at: '2026-01-01T00:00:00.000Z' });

    // Equal relevance: the newer memory is almost always the one wanted.
    expect(searchEpisodes('sailing')[0].at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('searches non-Latin text', async () => {
    const { addEpisode, searchEpisodes } = await mem();
    addEpisode({ kind: 'memo', text: 'Ideja za aplikaciju koja pamti beleške' });

    // These memos are often Serbian; splitting on [a-z] would find nothing.
    expect(searchEpisodes('beleške')).toHaveLength(1);
    expect(searchEpisodes('aplikaciju')).toHaveLength(1);
  });

  it('returns an excerpt around the match, not the whole memo', async () => {
    const { addEpisode, searchEpisodes } = await mem();
    const long = 'padding '.repeat(60) + 'the crucial detail ' + 'more '.repeat(60);
    addEpisode({ kind: 'memo', text: long });

    const hit = searchEpisodes('crucial')[0];
    expect(hit.excerpt).toContain('crucial');
    expect(hit.excerpt.length).toBeLessThan(250);
  });

  it('survives a corrupt line without losing the rest', async () => {
    const { addEpisode, loadEpisodes, episodesPath } = await mem();
    addEpisode({ id: 'a', kind: 'memo', text: 'first' });
    addEpisode({ id: 'b', kind: 'memo', text: 'second' });
    fs.appendFileSync(episodesPath(), '{ not json\n');

    // The reason for line-delimited storage: one bad write must not destroy
    // the whole history.
    expect(loadEpisodes().map(e => e.id)).toEqual(['a', 'b']);
  });

  it('forgets a single episode and keeps the others', async () => {
    const { addEpisode, deleteEpisode, loadEpisodes } = await mem();
    addEpisode({ id: 'keep', kind: 'memo', text: 'keep me' });
    addEpisode({ id: 'drop', kind: 'memo', text: 'drop me' });

    expect(deleteEpisode('drop')).toBe(true);
    expect(deleteEpisode('missing')).toBe(false);
    expect(loadEpisodes().map(e => e.id)).toEqual(['keep']);
  });

  it('derives a title from the first line when none is given', async () => {
    const { addEpisode } = await mem();
    const ep = addEpisode({ kind: 'memo', text: 'Booking app idea\nwith more detail below' });
    expect(ep.title).toBe('Booking app idea');
  });

  it('lists recent episodes newest first', async () => {
    const { addEpisode, recentEpisodes } = await mem();
    addEpisode({ kind: 'memo', text: 'older', at: '2024-01-01T00:00:00.000Z' });
    addEpisode({ kind: 'memo', text: 'newer', at: '2026-06-01T00:00:00.000Z' });

    expect(recentEpisodes()[0].text).toBe('newer');
  });
});

describe('recall tool', () => {
  it('says plainly when nothing matches', async () => {
    const { recallTool } = await import('../src/tools/recall.js');
    const out = recallTool({ action: 'search', query: 'submarines' });
    // So the model reports "nothing recorded" instead of inventing a memory.
    expect(out).toContain('Nothing was recorded');
  });

  it('records and then finds through the tool surface', async () => {
    const { recallTool } = await import('../src/tools/recall.js');
    recallTool({ action: 'add', text: 'Thought about a tide-aware kayak app', kind: 'memo' });

    const out = recallTool({ action: 'search', query: 'kayak' });
    expect(out).toContain('kayak');
    expect(out).toContain('matching');
  });

  it('rejects malformed calls instead of failing silently', async () => {
    const { recallTool } = await import('../src/tools/recall.js');
    expect(recallTool({ action: 'search' })).toContain('needs a query');
    expect(recallTool({ action: 'add' })).toContain('needs text');
    expect(recallTool({ action: 'forget' })).toContain('needs an id');
    expect(recallTool({ action: 'bogus' as never })).toContain('unknown action');
  });
});
