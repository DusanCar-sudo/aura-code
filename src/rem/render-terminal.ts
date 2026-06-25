import chalk from 'chalk';
import type { RemGraph } from './graph.js';

/**
 * Renders a `RemGraph` as terminal text using Aura's existing warm palette
 * (the same hex set used throughout src/cli/index.ts) so `:rem` looks native
 * next to `:dream`, `:design`, etc.
 *
 * Layout, top to bottom:
 *   1. A timeline strip — one row per night, oldest→newest, with a small bar
 *      sized by episode count.
 *   2. "What keeps coming up" — top tags ranked by total occurrence, with a
 *      horizontal bar and the count of distinct nights it appeared in.
 *   3. Per-night detail — for the most recent N nights, which tags fired.
 *
 * Deliberately not a literal node-and-edge ASCII graph (boxes-and-arrows in
 * a terminal degrade badly past ~6 nodes); a ranked/timeline view answers
 * the actual question ("what keeps coming up, and when") more legibly than
 * a force-directed layout would in 80 columns.
 */

const C = {
  heading: chalk.hex('#cc785c').bold,
  text: chalk.hex('#ede0cc'),
  muted: chalk.hex('#8a7768'),
  dim: chalk.hex('#4e3d30'),
  good: chalk.hex('#5a9e6e'),
  warn: chalk.hex('#b15439'),
};

const BAR_CHAR = '█';
const BAR_WIDTH = 24;

function bar(value: number, max: number, width = BAR_WIDTH): string {
  if (max <= 0) return '';
  const filled = Math.max(1, Math.round((value / max) * width));
  return BAR_CHAR.repeat(Math.min(filled, width));
}

export function renderRemTerminal(graph: RemGraph, opts: { recentNights?: number } = {}): string {
  const recentNights = opts.recentNights ?? 5;
  const lines: string[] = [];

  if (graph.nights.length === 0) {
    return C.muted('\n  No dreams yet. Run :dream after some work.\n');
  }

  lines.push('');
  lines.push(C.heading(`  Rem — ${graph.nights.length} night(s), ${graph.topTags.length} recurring tag(s)`));
  lines.push('');

  // ── 1. Timeline strip ──────────────────────────────────────────────────
  lines.push(C.muted('  Timeline'));
  const maxEpisodes = Math.max(...graph.nights.map(n => n.episodeCount), 1);
  for (const night of graph.nights) {
    const tagCount = new Set(night.occurrences.map(o => o.tag)).size;
    lines.push(
      `  ${C.text(night.date)}  ${C.dim(bar(night.episodeCount, maxEpisodes, 16))}  ` +
      C.muted(`${night.episodeCount} ep · ${tagCount} tag(s)`),
    );
  }
  lines.push('');

  // ── 2. Top tags ranked by total occurrence ─────────────────────────────
  lines.push(C.muted('  What keeps coming up'));
  const maxCount = graph.topTags[0]?.count ?? 1;
  for (const t of graph.topTags.slice(0, 12)) {
    const label = `[${t.tag}]`.padEnd(20);
    lines.push(
      `  ${C.heading(label)} ${C.text(bar(t.count, maxCount))} ` +
      C.muted(`${t.count}× across ${t.nights} night(s)`),
    );
  }
  lines.push('');

  // ── 3. Per-night detail for the most recent nights ─────────────────────
  const recent = graph.nights.slice(-recentNights).reverse();
  lines.push(C.muted(`  Recent detail (last ${recent.length})`));
  for (const night of recent) {
    lines.push(`  ${C.heading(night.date)}`);
    if (night.occurrences.length === 0) {
      lines.push(`    ${C.muted('(no tagged lessons/threads)')}`);
      continue;
    }
    const byTag = new Map<string, string[]>();
    for (const occ of night.occurrences) {
      if (!byTag.has(occ.tag)) byTag.set(occ.tag, []);
      byTag.get(occ.tag)!.push(occ.text);
    }
    for (const [tag, texts] of byTag) {
      const sample = texts[0].length > 72 ? texts[0].slice(0, 69) + '...' : texts[0];
      const more = texts.length > 1 ? C.muted(` (+${texts.length - 1} more)`) : '';
      lines.push(`    ${C.warn(`[${tag}]`)} ${C.text(sample)}${more}`);
    }
  }
  lines.push('');
  lines.push(C.muted('  :rem --html  writes a visual graph to dreams/rem.html'));
  lines.push('');

  return lines.join('\n');
}
