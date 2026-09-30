/**
 * The journey screen — `:journey` in the REPL, `aura journey` on its own.
 *
 * Full screen: the day chart on top, everything Aura did and learned below,
 * Enter opens one item in full. It draws the frames from
 * agent/learning-graph.ts, the same ones `learning.frames` sends to other
 * clients, and only adds color, a separator and a key-help line.
 *
 * The logic is two pure functions — {@link renderJourney} (state → lines)
 * and {@link journeyKey} (state + key → state) — so it is tested without a
 * terminal; {@link runJourneyView} is the thin loop that owns the tty.
 */

import chalk from 'chalk';
import {
  buildLearningGraph, learningFrames, journeyDetail, type LearningGraph,
} from '../agent/learning-graph.js';
import { CHROME, CHROME_DIM, ERR, OK, SOFT } from './diamond.js';

const ACCENT = CHROME;
const DIM = CHROME_DIM;
const TEXT = SOFT;

/** Window lengths `w` cycles through, in days. */
export const WINDOWS = [7, 30, 90, 365];

export interface JourneyState {
  graph: LearningGraph;
  days: number;
  selected: number;
  offset: number;
  mode: 'list' | 'detail';
  detailScroll: number;
}

export function initialState(graph: LearningGraph, days: number): JourneyState {
  return { graph, days, selected: 0, offset: 0, mode: 'list', detailScroll: 0 };
}

function colorChart(line: string, i: number): string {
  if (i === 0) return ACCENT.bold(line);
  return [...line].map(ch =>
    ch === '█' ? OK(ch) : ch === '░' ? ERR(ch) : ch === '+' || ch === '|' ? ACCENT(ch) : DIM(ch),
  ).join('');
}

function colorRow(line: string): string {
  const sel = line.startsWith('>');
  const body = line
    .replace(' ✓ ', ` ${OK('✓')} `)
    .replace(' ✗ ', ` ${ERR('✗')} `)
    .replace(/ \+ lesson /, ` ${ACCENT('+ lesson')} `);
  return sel ? ACCENT('>') + chalk.bold(TEXT(body.slice(1))) : TEXT(body);
}

/** The whole screen for a terminal of cols × rows. Every line fits `cols`. */
export function renderJourney(s: JourneyState, cols: number, rows: number): string[] {
  const w = Math.max(20, cols);
  const h = Math.max(8, rows);
  if (s.mode === 'detail') {
    const item = s.graph.items[s.selected];
    const body = item ? journeyDetail(item, w - 2) : ['(nothing selected)'];
    const view = body.slice(s.detailScroll, s.detailScroll + h - 2);
    return [
      ...view.map((l, i) => ' ' + (i === 0 && s.detailScroll === 0 ? ACCENT(l) : TEXT(l))),
      ...Array(Math.max(0, h - 2 - view.length)).fill(''),
      DIM('─'.repeat(w)),
      DIM(fitPlain(' ↑↓ scroll · Esc back · q close', w)),
    ];
  }
  const f = learningFrames(s.graph, { cols: w, rows: h - 1, selected: s.selected, offset: s.offset });
  const lines = [
    ...f.chart.map(colorChart),
    DIM('─'.repeat(w)),
    ...f.list.map(colorRow),
  ];
  while (lines.length < h - 1) lines.push('');
  const pos = f.total ? `${s.selected + 1}/${f.total}` : '0/0';
  lines.push(DIM(fitPlain(` ↑↓ move · Enter open · w window (${s.days}d) · r reload · q close   ${pos}`, w)));
  return lines;
}

function fitPlain(s: string, w: number): string {
  return s.length > w ? s.slice(0, w - 1) + '…' : s;
}

export type JourneyAction = JourneyState | 'exit' | { reload: number };

/**
 * One key. Returns the next state, 'exit', or `{reload: days}` when the
 * graph must be rebuilt (reload or a different window). `rows` is the
 * screen height, for page moves.
 */
export function journeyKey(s: JourneyState, key: string, rows: number): JourneyAction {
  const total = s.graph.items.length;
  const page = Math.max(1, rows - 16);
  const up = key === '\x1b[A' || key === 'k';
  const down = key === '\x1b[B' || key === 'j';

  if (key === '\x03') return 'exit';
  if (s.mode === 'detail') {
    if (key === '\x1b' || key === '\x7f' || key === 'h' || key === '\x1b[D') return { ...s, mode: 'list', detailScroll: 0 };
    if (key === 'q') return 'exit';
    if (up) return { ...s, detailScroll: Math.max(0, s.detailScroll - 1) };
    if (down) return { ...s, detailScroll: s.detailScroll + 1 };
    if (key === '\x1b[5~') return { ...s, detailScroll: Math.max(0, s.detailScroll - page) };
    if (key === '\x1b[6~') return { ...s, detailScroll: s.detailScroll + page };
    return s;
  }
  const to = (n: number) => ({ ...s, selected: Math.max(0, Math.min(Math.max(0, total - 1), n)) });
  if (key === 'q' || key === '\x1b') return 'exit';
  if (up) return to(s.selected - 1);
  if (down) return to(s.selected + 1);
  if (key === '\x1b[5~') return to(s.selected - page);
  if (key === '\x1b[6~') return to(s.selected + page);
  if (key === 'g' || key === '\x1b[H' || key === '\x1b[1~') return to(0);
  if (key === 'G' || key === '\x1b[F' || key === '\x1b[4~') return to(total - 1);
  if ((key === '\r' || key === '\n' || key === 'l' || key === '\x1b[C') && total) return { ...s, mode: 'detail', detailScroll: 0 };
  if (key === 'r') return { reload: s.days };
  if (key === 'w') return { reload: WINDOWS[(WINDOWS.indexOf(s.days) + 1) % WINDOWS.length] };
  return s;
}

/** Split a raw stdin chunk into keys: CSI/SS3 sequences, else single chars. */
export function splitKeys(chunk: string): string[] {
  return chunk.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/g) ?? [];
}

export interface JourneyViewOptions {
  projectRoot?: string;
  days?: number;
  /** Switch to the terminal's alternate screen (skip when the caller already did). */
  altScreen?: boolean;
}

/** Take over the terminal until the user closes the view. */
export function runJourneyView(opts: JourneyViewOptions = {}): Promise<void> {
  const out = process.stdout;
  const inp = process.stdin;
  const build = (days: number) => buildLearningGraph({ days, projectRoot: opts.projectRoot });
  const startDays = opts.days ?? 30;
  let s = initialState(build(startDays), startDays);

  const draw = () => {
    const cols = out.columns ?? 80;
    const rows = out.rows ?? 24;
    const lines = renderJourney(s, cols, rows);
    out.write('\x1b[H\x1b[2J' + lines.join('\r\n'));
  };

  return new Promise(resolve => {
    const wasRaw = inp.isTTY ? inp.isRaw : false;
    if (opts.altScreen) out.write('\x1b[?1049h');
    out.write('\x1b[?25l\x1b[r'); // hide cursor, whole screen is ours
    if (inp.isTTY) inp.setRawMode(true);
    inp.setEncoding('utf8');
    inp.resume();

    const onData = (chunk: string) => {
      for (const key of splitKeys(chunk)) {
        const next = journeyKey(s, key, out.rows ?? 24);
        if (next === 'exit') return finish();
        if ('reload' in next) {
          const keep = s.graph.items[s.selected]?.id;
          const g = build(next.reload);
          const idx = keep ? g.items.findIndex(i => i.id === keep) : -1;
          s = { ...initialState(g, next.reload), selected: Math.max(0, idx) };
        } else {
          s = next;
        }
      }
      draw();
    };
    const finish = () => {
      inp.removeListener('data', onData);
      out.removeListener('resize', draw);
      if (inp.isTTY) inp.setRawMode(wasRaw);
      inp.pause();
      out.write('\x1b[?25h');
      if (opts.altScreen) out.write('\x1b[?1049l');
      resolve();
    };
    inp.on('data', onData);
    out.on('resize', draw);
    draw();
  });
}
