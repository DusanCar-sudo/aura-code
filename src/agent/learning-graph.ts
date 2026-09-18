/**
 * The learning journey — what Aura did and learned, day by day.
 *
 * One builder and one renderer, and every surface is a thin view over them:
 * `GET /api/learning/graph` returns {@link buildLearningGraph} as JSON, the
 * `learning.frames` protocol method returns {@link learningFrames}, and the
 * TUI's journey overlay draws those same frames. Two renderers would drift;
 * one cannot.
 *
 * Three stores feed it, all already on disk, read-only here, no LLM calls:
 *   runs      ~/.aura/episodes/<project>/*.json   (task, model, success)
 *   memories  ~/.aura/memory/episodes.jsonl       (decisions, notes, memos)
 *   lessons   lessons-global.md + <project>/.aura/lessons.md
 *
 * Eras: a data reset archives the stores under ~/.aura/archive/<dir>/ with a
 * MANIFEST.json. The graph lists those so a chart can mark where the counting
 * started over — the numbers before a reset measured a different thing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { auraPath } from '../util/aura-home.js';
import { listAllEpisodes } from '../dream/episode.js';
import { loadEpisodes } from './episodic-memory.js';
import { loadLessons } from './learning.js';

export type JourneyKind = 'run' | 'lesson' | 'memory';

export interface JourneyItem {
  id: string;
  /** ISO timestamp. */
  at: string;
  kind: JourneyKind;
  title: string;
  text: string;
  /** Runs only: did it succeed. */
  ok?: boolean;
  /** Where it came from: model for runs, scope for lessons, kind for memories. */
  source: string;
}

export interface JourneyDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  runs: number;
  succeeded: number;
  failed: number;
  lessons: number;
  memories: number;
}

export interface JourneyEra {
  label: string;
  archivedAt: string;
}

export interface LearningGraph {
  since: string;
  until: string;
  days: JourneyDay[];
  /** Newest first. */
  items: JourneyItem[];
  totals: { runs: number; succeeded: number; failed: number; lessons: number; memories: number };
  eras: JourneyEra[];
}

export interface GraphOptions {
  projectRoot?: string;
  /** YYYY-MM-DD, inclusive. Default: `days` before `until`. */
  since?: string;
  /** YYYY-MM-DD, inclusive. Default: today. */
  until?: string;
  /** Window length when `since` is not given. */
  days?: number;
  /** For tests. */
  now?: Date;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(s: string, n: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return localDate(d);
}

export function isDate(s: unknown): s is string {
  return typeof s === 'string' && DATE.test(s) && !isNaN(parseDate(s).getTime());
}

function oneLine(s: string, max = 120): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function collect(projectRoot?: string): JourneyItem[] {
  const items: JourneyItem[] = [];
  for (const e of listAllEpisodes()) {
    if (typeof e?.timestamp !== 'number') continue;
    items.push({
      id: e.id, at: new Date(e.timestamp).toISOString(), kind: 'run',
      title: oneLine(e.task), text: e.task || '', ok: !!e.success, source: e.model || '',
    });
  }
  for (const m of loadEpisodes()) {
    if (isNaN(Date.parse(m.at))) continue;
    items.push({
      id: m.id, at: new Date(m.at).toISOString(), kind: 'memory',
      title: oneLine(m.title || m.text), text: m.text, source: m.kind || 'memory',
    });
  }
  const lessons = [...loadLessons('global'), ...(projectRoot ? loadLessons('project', projectRoot) : [])];
  for (const l of lessons) {
    // lessons carry a bare date; noon local keeps it on that day in any timezone
    const at = isDate(l.learnedAt) ? new Date(parseDate(l.learnedAt).setHours(12)) : new Date(l.learnedAt);
    if (isNaN(at.getTime())) continue;
    items.push({
      id: `${l.scope}:${l.key}`, at: at.toISOString(), kind: 'lesson',
      title: oneLine(l.text), text: l.text, source: l.scope,
    });
  }
  return items;
}

export function loadEras(): JourneyEra[] {
  const base = auraPath('archive');
  let dirs: string[];
  try { dirs = fs.readdirSync(base); } catch { return []; }
  const eras: JourneyEra[] = [];
  for (const d of dirs) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(base, d, 'MANIFEST.json'), 'utf8'));
      if (typeof m.label === 'string' && !isNaN(Date.parse(m.archivedAt))) {
        eras.push({ label: m.label, archivedAt: new Date(m.archivedAt).toISOString() });
      }
    } catch { /* not an archive */ }
  }
  return eras.sort((a, b) => a.archivedAt.localeCompare(b.archivedAt));
}

export function buildLearningGraph(opts: GraphOptions = {}): LearningGraph {
  const until = opts.until ?? localDate(opts.now ?? new Date());
  const since = opts.since ?? addDays(until, -((opts.days ?? 30) - 1));
  const days: JourneyDay[] = [];
  const byDate = new Map<string, JourneyDay>();
  for (let d = since; d <= until && days.length < 3660; d = addDays(d, 1)) {
    const day = { date: d, runs: 0, succeeded: 0, failed: 0, lessons: 0, memories: 0 };
    days.push(day);
    byDate.set(d, day);
  }

  const items = collect(opts.projectRoot).filter(i => byDate.has(localDate(new Date(i.at))));
  const totals = { runs: 0, succeeded: 0, failed: 0, lessons: 0, memories: 0 };
  for (const i of items) {
    const day = byDate.get(localDate(new Date(i.at)))!;
    if (i.kind === 'run') {
      day.runs++; totals.runs++;
      if (i.ok) { day.succeeded++; totals.succeeded++; } else { day.failed++; totals.failed++; }
    } else if (i.kind === 'lesson') { day.lessons++; totals.lessons++; }
    else { day.memories++; totals.memories++; }
  }
  items.sort((a, b) => b.at.localeCompare(a.at));
  return { since, until, days, items, totals, eras: loadEras() };
}

// ── Frames: the graph laid out for a terminal of a given size ──────────────

export interface FrameOptions {
  cols: number;
  rows: number;
  /** First list row shown. */
  offset?: number;
  /** Index into graph.items of the highlighted row. */
  selected?: number;
}

export interface LearningFrames {
  /** Header + bar chart + date axis. */
  chart: string[];
  /** The visible slice of the item list; the selected row starts with '>'. */
  list: string[];
  /** Number of items in the whole list. */
  total: number;
  /** The offset actually used (clamped so `selected` is visible). */
  offset: number;
}

const MARK: Record<JourneyKind, string> = { run: 'run   ', lesson: 'lesson', memory: 'memory' };

function fit(s: string, w: number): string {
  if (w <= 0) return '';
  return s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s;
}

/**
 * Plain text, no color codes: each client colors it its own way. Chart
 * glyphs: '█' a successful run, '░' a failed one, '+' under a day that
 * gained a lesson or memory, '|' a reset (era boundary).
 */
export function learningFrames(g: LearningGraph, o: FrameOptions): LearningFrames {
  const cols = Math.max(20, Math.floor(o.cols));
  const rows = Math.max(8, Math.floor(o.rows));

  const t = g.totals;
  const rate = t.runs ? Math.round((t.succeeded / t.runs) * 100) : 0;
  const header = fit(`journey ${g.since} → ${g.until}   runs ${t.runs} (${rate}% ok)   lessons ${t.lessons}   memories ${t.memories}`, cols);

  // one column per day, newest on the right; drop old days that don't fit
  const width = cols - 4;
  const days = g.days.slice(-width);
  const chartH = Math.max(3, Math.min(10, Math.floor(rows * 0.35)));
  const peak = Math.max(1, ...days.map(d => d.runs));
  const reset = new Set(g.eras.map(e => localDate(new Date(e.archivedAt))));
  const bars: string[] = [];
  for (let r = chartH; r >= 1; r--) {
    let line = r === chartH ? String(peak).padStart(3) + ' ' : '    ';
    for (const d of days) {
      const ok = Math.round((d.succeeded / peak) * chartH);
      const all = Math.max(d.runs ? 1 : 0, Math.round((d.runs / peak) * chartH));
      line += r <= ok ? '█' : r <= all ? '░' : reset.has(d.date) ? '|' : ' ';
    }
    bars.push(line);
  }
  const marks = '    ' + days.map(d => (d.lessons || d.memories ? '+' : ' ')).join('');
  const first = days[0]?.date.slice(5) ?? '';
  const last = days[days.length - 1]?.date.slice(5) ?? '';
  const axis = '    ' + first + ' '.repeat(Math.max(1, days.length - first.length - last.length)) + last;
  const chart = [header, '', ...bars, marks, fit(axis, cols)];

  // the list gets what's left, minus one separator line
  const listH = Math.max(1, rows - chart.length - 1);
  const total = g.items.length;
  const selected = Math.min(Math.max(0, o.selected ?? 0), Math.max(0, total - 1));
  let offset = Math.max(0, Math.min(o.offset ?? 0, Math.max(0, total - listH)));
  if (selected < offset) offset = selected;
  if (selected >= offset + listH) offset = selected - listH + 1;
  const list = g.items.slice(offset, offset + listH).map((it, k) => {
    const cur = offset + k === selected ? '>' : ' ';
    const when = localDate(new Date(it.at)).slice(5);
    const mark = it.kind === 'run' ? (it.ok ? '✓' : '✗') : it.kind === 'lesson' ? '+' : '·';
    return fit(`${cur} ${when} ${mark} ${MARK[it.kind]} ${it.title}`, cols);
  });
  if (!total) list.push(fit('  nothing in this window yet', cols));
  return { chart, list, total, offset };
}

/** One item, word-wrapped to `cols`, for the drill-in view. */
export function journeyDetail(it: JourneyItem, cols: number): string[] {
  const w = Math.max(20, Math.floor(cols));
  const head = `${it.at.replace('T', ' ').slice(0, 16)}  ${it.kind}${it.kind === 'run' ? (it.ok ? ' ✓' : ' ✗') : ''}  ${it.source}`;
  const out = [fit(head, w), ''];
  for (const para of it.text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > w) { out.push(line); line = ''; }
      line = line ? `${line} ${word}` : word.length > w ? fit(word, w) : word;
    }
    out.push(line);
  }
  return out;
}
