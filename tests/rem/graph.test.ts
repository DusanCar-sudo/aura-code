import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDreamFile, loadDreamNights, buildRemGraph, loadRemGraph } from '../../src/rem/graph.js';

function writeDream(dir: string, date: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${date}.md`);
  fs.writeFileSync(p, body);
  return p;
}

const DREAM_A = `# Dream — 2026-06-22

> 65 episodes recalled since beginning · 42 approved · 0 ruby wins
> Categories: other, research, implementation, review

## Lessons
- [error] consolidation model failed: too few credits for requested max_tokens

## Patterns
- none

## Open threads
- [todo] re-run :dream once the provider is reachable

## Tomorrow brief
Consolidation could not run; episodes are preserved and will be recalled next dream.
`;

const DREAM_B = `# Dream — 2026-06-24

> 69 episodes recalled since beginning · 46 approved · 2 ruby wins
> Categories: other, research, implementation, review

## Lessons
- [configuration] path resolution is sensitive to working directory
- [safety] safety-blocked message means task was blocked by the safety checker
- [tooling] a HistoryMessage union type burst across modules can break builds

## Patterns
- Unclear commands circle until a precise, safety-bypassed approve triggers execution.
- Multi-device orchestration pattern recurs.

## Open threads
- [todo] build real-time telemetry
- [todo] transcribe the kanban recording
- [safety] confirm the safety toggle persists across sessions

## Tomorrow brief
Finish the lingering telemetry command.
`;

describe('parseDreamFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-rem-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts date, episode count, and tagged lessons/threads', () => {
    const p = writeDream(tmpDir, '2026-06-24', DREAM_B);
    const night = parseDreamFile(p);

    expect(night.date).toBe('2026-06-24');
    expect(night.episodeCount).toBe(69);
    // 3 lessons + 3 open-threads tagged bullets = 6 occurrences
    expect(night.occurrences).toHaveLength(6);
    expect(night.occurrences.map(o => o.tag)).toEqual(
      expect.arrayContaining(['configuration', 'safety', 'tooling', 'todo']),
    );
  });

  it('counts patterns but excludes a bare "- none" pattern bullet', () => {
    const p = writeDream(tmpDir, '2026-06-22', DREAM_A);
    const night = parseDreamFile(p);
    expect(night.patternCount).toBe(0); // DREAM_A's only pattern line is "- none"

    const pB = writeDream(tmpDir, '2026-06-24', DREAM_B);
    const nightB = parseDreamFile(pB);
    expect(nightB.patternCount).toBe(2);
  });

  it('degrades gracefully on a minimal one-lesson dream (real-world 402 failure case)', () => {
    const p = writeDream(tmpDir, '2026-06-22', DREAM_A);
    const night = parseDreamFile(p);
    expect(night.occurrences).toHaveLength(2); // [error] + [todo]
    expect(night.occurrences[0]).toMatchObject({ tag: 'error', section: 'lessons' });
    expect(night.occurrences[1]).toMatchObject({ tag: 'todo', section: 'open-threads' });
  });

  it('handles a file with no recognizable sections without throwing', () => {
    const p = writeDream(tmpDir, '2026-06-20', '# Dream — 2026-06-20\n\nNothing structured here.\n');
    const night = parseDreamFile(p);
    expect(night.occurrences).toEqual([]);
    expect(night.episodeCount).toBe(0);
    expect(night.patternCount).toBe(0);
  });

  it('falls back to the filename when no date appears in the body', () => {
    const p = writeDream(tmpDir, '2026-06-21', '# Untitled\n\nNo header line.\n');
    const night = parseDreamFile(p);
    expect(night.date).toBe('2026-06-21'); // taken from filename
  });
});

describe('loadDreamNights', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-rem-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty array when there is no dreams/ dir', () => {
    expect(loadDreamNights(tmpDir)).toEqual([]);
  });

  it('loads all dream files sorted oldest-first by filename', () => {
    const dreamsDir = path.join(tmpDir, 'dreams');
    writeDream(dreamsDir, '2026-06-24', DREAM_B);
    writeDream(dreamsDir, '2026-06-22', DREAM_A);

    const nights = loadDreamNights(tmpDir);
    expect(nights.map(n => n.date)).toEqual(['2026-06-22', '2026-06-24']);
  });

  it('ignores non-markdown files (e.g. the .last.json state file)', () => {
    const dreamsDir = path.join(tmpDir, 'dreams');
    writeDream(dreamsDir, '2026-06-24', DREAM_B);
    fs.writeFileSync(path.join(dreamsDir, '.last.json'), '{"lastDreamTs":123}');

    const nights = loadDreamNights(tmpDir);
    expect(nights).toHaveLength(1);
  });
});

describe('buildRemGraph', () => {
  it('builds bipartite night/tag nodes and edges with correct weights', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-rem-'));
    try {
      const dreamsDir = path.join(tmpDir, 'dreams');
      writeDream(dreamsDir, '2026-06-22', DREAM_A);
      writeDream(dreamsDir, '2026-06-24', DREAM_B);

      const graph = loadRemGraph(tmpDir);

      expect(graph.nights).toHaveLength(2);

      const nightNodes = graph.nodes.filter(n => n.kind === 'night');
      const tagNodes = graph.nodes.filter(n => n.kind === 'tag');
      expect(nightNodes.map(n => n.id)).toEqual(['2026-06-22', '2026-06-24']);
      // distinct tags across both nights: error, todo, configuration, safety, tooling
      expect(tagNodes).toHaveLength(5);

      // "todo" appears once in DREAM_A + twice in DREAM_B → total 3, across 2 nights.
      const todo = graph.topTags.find(t => t.tag === 'todo');
      expect(todo).toMatchObject({ count: 3, nights: 2 });

      // "safety" appears twice on 2026-06-24 only (Lessons + Open threads).
      const safety = graph.topTags.find(t => t.tag === 'safety');
      expect(safety).toMatchObject({ count: 2, nights: 1 });

      const safetyEdge = graph.edges.find(e => e.night === '2026-06-24' && e.tag === 'safety');
      expect(safetyEdge?.weight).toBe(2);

      // topTags sorted descending by count.
      const counts = graph.topTags.map(t => t.count);
      expect(counts).toEqual([...counts].sort((a, b) => b - a));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns an empty graph for zero nights without throwing', () => {
    const graph = buildRemGraph([]);
    expect(graph.nights).toEqual([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.topTags).toEqual([]);
  });
});
