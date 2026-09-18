import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildLearningGraph, learningFrames, journeyDetail, localDate, isDate,
} from '../../src/agent/learning-graph.js';

let home: string;
let proj: string;

// local noon on a given day: stays on that day in every timezone
const noon = (d: string) => { const [y, m, day] = d.split('-').map(Number); return new Date(y, m - 1, day, 12); };

function run(day: string, task: string, success: boolean, n = 0) {
  const dir = path.join(home, 'episodes', 'abc123');
  fs.mkdirSync(dir, { recursive: true });
  const ts = noon(day).getTime() + n;
  fs.writeFileSync(path.join(dir, `${ts}-x${n}.json`),
    JSON.stringify({ id: `${ts}-x${n}`, timestamp: ts, task, model: 'glm-5.1', success, tokens: 1, durationMs: 0 }));
}

function memory(day: string, title: string) {
  const f = path.join(home, 'memory', 'episodes.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify({ id: title, at: noon(day).toISOString(), kind: 'decision', title, text: `${title} — the long text`, tags: [] }) + '\n');
}

function lesson(day: string, text: string, key: string) {
  const f = path.join(home, 'memory', 'lessons-global.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `- ${text} <!-- k:${key} t:${day} -->\n`);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-journey-home-'));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-journey-proj-'));
  vi.stubEnv('AURA_HOME', home);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('buildLearningGraph', () => {
  it('is empty but well-formed with no data', () => {
    const g = buildLearningGraph({ until: '2026-09-19', days: 7 });
    expect(g.since).toBe('2026-09-13');
    expect(g.days).toHaveLength(7);
    expect(g.items).toEqual([]);
    expect(g.totals).toEqual({ runs: 0, succeeded: 0, failed: 0, lessons: 0, memories: 0 });
    expect(g.eras).toEqual([]);
  });

  it('counts runs, lessons and memories into their days', () => {
    run('2026-09-17', 'fix waybar', true, 1);
    run('2026-09-17', 'fix sway', false, 2);
    run('2026-09-18', 'splash', true, 3);
    memory('2026-09-18', 'chose aura-term');
    lesson('2026-09-19', 'sway PATH lacks ~/.local/bin', 'sway-path');
    const g = buildLearningGraph({ since: '2026-09-17', until: '2026-09-19' });
    expect(g.days.map(d => [d.date, d.runs, d.succeeded, d.failed, d.memories, d.lessons])).toEqual([
      ['2026-09-17', 2, 1, 1, 0, 0],
      ['2026-09-18', 1, 1, 0, 1, 0],
      ['2026-09-19', 0, 0, 0, 0, 1],
    ]);
    expect(g.totals).toEqual({ runs: 3, succeeded: 2, failed: 1, lessons: 1, memories: 1 });
    expect(g.items.map(i => i.kind)).toEqual(['lesson', 'run', 'memory', 'run', 'run']); // newest first (the run is 3 ms after noon)
  });

  it('leaves out anything outside the window', () => {
    run('2026-08-01', 'old', true);
    run('2026-09-19', 'new', true, 1);
    const g = buildLearningGraph({ since: '2026-09-01', until: '2026-09-19' });
    expect(g.items.map(i => i.title)).toEqual(['new']);
  });

  it('reads project lessons only when given the project', () => {
    fs.mkdirSync(path.join(proj, '.aura'));
    fs.writeFileSync(path.join(proj, '.aura', 'lessons.md'), '- here tests need AURA_HOME <!-- k:t t:2026-09-19 -->\n');
    expect(buildLearningGraph({ until: '2026-09-19' }).totals.lessons).toBe(0);
    expect(buildLearningGraph({ until: '2026-09-19', projectRoot: proj }).totals.lessons).toBe(1);
  });

  it('survives corrupt files', () => {
    fs.mkdirSync(path.join(home, 'episodes', 'p'), { recursive: true });
    fs.writeFileSync(path.join(home, 'episodes', 'p', 'bad.json'), '{nope');
    fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(home, 'memory', 'episodes.jsonl'), 'garbage\n');
    run('2026-09-19', 'ok', true);
    expect(buildLearningGraph({ until: '2026-09-19' }).totals.runs).toBe(1);
  });

  it('lists eras from archive manifests, oldest first', () => {
    for (const [dir, label, at] of [['b', 'second', '2026-10-30T00:00:00Z'], ['a', 'dev-phase', '2026-09-30T00:00:00Z']]) {
      fs.mkdirSync(path.join(home, 'archive', dir), { recursive: true });
      fs.writeFileSync(path.join(home, 'archive', dir, 'MANIFEST.json'), JSON.stringify({ label, archivedAt: at }));
    }
    fs.mkdirSync(path.join(home, 'archive', 'junk'));
    expect(buildLearningGraph().eras.map(e => e.label)).toEqual(['dev-phase', 'second']);
  });
});

describe('learningFrames', () => {
  it('fits every line to the width and the whole frame to the height', () => {
    for (let i = 0; i < 40; i++) run('2026-09-19', `task number ${i} with a fairly long description attached`, i % 3 > 0, i);
    const g = buildLearningGraph({ until: '2026-09-19' });
    for (const [cols, rows] of [[40, 12], [80, 24], [200, 60]]) {
      const f = learningFrames(g, { cols, rows });
      expect(f.total).toBe(40);
      for (const l of [...f.chart, ...f.list]) expect(l.length).toBeLessThanOrEqual(cols);
      expect(f.chart.length + 1 + f.list.length).toBeLessThanOrEqual(rows);
    }
  });

  it('draws successes solid and failures hatched', () => {
    run('2026-09-19', 'a', true, 1);
    run('2026-09-19', 'b', false, 2);
    const f = learningFrames(buildLearningGraph({ until: '2026-09-19', days: 3 }), { cols: 40, rows: 20 });
    const col = f.chart.slice(2, -2).map(l => l.slice(4).at(-1)).join('');
    expect(col).toContain('█');
    expect(col).toContain('░');
  });

  it('keeps the selected row visible and marks it', () => {
    for (let i = 0; i < 50; i++) run('2026-09-19', `t${i}`, true, i);
    const g = buildLearningGraph({ until: '2026-09-19' });
    const f = learningFrames(g, { cols: 60, rows: 20, selected: 45 });
    const sel = f.list.filter(l => l.startsWith('>'));
    expect(sel).toHaveLength(1);
    expect(sel[0]).toContain(g.items[45].title);
    expect(f.offset).toBeGreaterThan(0);
  });

  it('says so when the window is empty', () => {
    const f = learningFrames(buildLearningGraph({ until: '2026-09-19' }), { cols: 60, rows: 20 });
    expect(f.list.join('')).toContain('nothing');
  });
});

describe('journeyDetail', () => {
  it('wraps the full text to the width', () => {
    const d = journeyDetail({ id: 'x', at: '2026-09-19T05:00:00.000Z', kind: 'memory', title: 't', source: 'decision',
      text: 'word '.repeat(60).trim() }, 30);
    expect(d.length).toBeGreaterThan(5);
    for (const l of d) expect(l.length).toBeLessThanOrEqual(30);
  });
});

describe('dates', () => {
  it('validates YYYY-MM-DD', () => {
    expect(isDate('2026-09-19')).toBe(true);
    expect(isDate('2026-9-19')).toBe(false);
    expect(isDate('yesterday')).toBe(false);
    expect(localDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
