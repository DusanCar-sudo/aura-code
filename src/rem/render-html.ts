import type { RemGraph } from './graph.js';

/**
 * Renders a `RemGraph` as a standalone themed HTML file containing a real
 * SVG node-and-edge graph (night nodes in a row, tag nodes arranged around
 * them, edges weighted by occurrence count) plus a ranked tag list below it.
 *
 * Visually matches the warm/cream "Aura" theme used by :research / :council
 * (see src/research/council.ts's wrapHtml) so output feels consistent
 * across the agent's generated docs, with a dark-mode variant via
 * prefers-color-scheme.
 *
 * Layout is a deterministic two-row bipartite layout (nights on top,
 * tags on bottom, both sorted), NOT a physics-simulated force layout —
 * this keeps the SVG static, dependency-free, and stable across renders of
 * the same data (no jitter, no client-side JS layout pass required).
 */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PALETTE = [
  '#cc785c', '#5a9e6e', '#b15439', '#7a8ecc', '#c2a35a', '#9e6ecc', '#5aa3a8',
];

function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

function buildSvg(graph: RemGraph): string {
  const nightIds = graph.nights.map(n => n.date);
  const tagIds = graph.topTags.map(t => t.tag);

  const width = Math.max(720, Math.max(nightIds.length, tagIds.length) * 110 + 80);
  const nightY = 90;
  const tagY = 330;
  const height = tagY + 90;

  const nightX = new Map<string, number>();
  nightIds.forEach((id, i) => {
    const gap = nightIds.length > 1 ? (width - 120) / (nightIds.length - 1) : 0;
    nightX.set(id, 60 + gap * i);
  });

  const tagX = new Map<string, number>();
  tagIds.forEach((id, i) => {
    const gap = tagIds.length > 1 ? (width - 120) / (tagIds.length - 1) : 0;
    tagX.set(id, 60 + gap * i);
  });

  const maxEpisodes = Math.max(...graph.nights.map(n => n.episodeCount), 1);
  const maxTagCount = graph.topTags[0]?.count ?? 1;
  const maxEdgeWeight = Math.max(...graph.edges.map(e => e.weight), 1);

  const edgeLines = graph.edges.map(e => {
    const x1 = nightX.get(e.night);
    const y1 = nightY;
    const x2 = tagX.get(e.tag);
    const y2 = tagY;
    if (x1 === undefined || x2 === undefined) return '';
    const strokeW = 1 + (e.weight / maxEdgeWeight) * 3.5;
    const tagIdx = tagIds.indexOf(e.tag);
    const color = colorFor(tagIdx);
    return `<line x1="${x1}" y1="${y1 + 14}" x2="${x2}" y2="${y2 - 22}" stroke="${color}" stroke-width="${strokeW.toFixed(2)}" stroke-opacity="0.45" />`;
  }).join('\n      ');

  const nightNodes = nightIds.map(id => {
    const night = graph.nights.find(n => n.date === id)!;
    const r = 8 + (night.episodeCount / maxEpisodes) * 14;
    const x = nightX.get(id)!;
    return `
      <g class="node night-node">
        <circle cx="${x}" cy="${nightY}" r="${r.toFixed(1)}" class="night-circle" />
        <text x="${x}" y="${nightY - r - 8}" class="night-label" text-anchor="middle">${esc(id)}</text>
        <text x="${x}" y="${nightY + r + 16}" class="night-sub" text-anchor="middle">${night.episodeCount} ep</text>
      </g>`;
  }).join('');

  const tagNodes = tagIds.map((id, i) => {
    const t = graph.topTags[i];
    const r = 6 + (t.count / maxTagCount) * 16;
    const x = tagX.get(id)!;
    const color = colorFor(i);
    return `
      <g class="node tag-node">
        <circle cx="${x}" cy="${tagY}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.85" />
        <text x="${x}" y="${tagY + r + 18}" class="tag-label" text-anchor="middle" fill="${color}">[${esc(id)}]</text>
        <text x="${x}" y="${tagY + r + 34}" class="tag-sub" text-anchor="middle">${t.count}×</text>
      </g>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" class="rem-graph">
  <g class="edges">
      ${edgeLines}
  </g>
  <g class="nights">${nightNodes}
  </g>
  <g class="tags">${tagNodes}
  </g>
</svg>`;
}

function buildTopTagsTable(graph: RemGraph): string {
  const rows = graph.topTags.slice(0, 20).map((t, i) => {
    const color = colorFor(i);
    const pct = graph.topTags[0] ? Math.round((t.count / graph.topTags[0].count) * 100) : 0;
    return `<tr>
      <td class="tag-cell"><span class="dot" style="background:${color}"></span>[${esc(t.tag)}]</td>
      <td><div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div></td>
      <td class="num-cell">${t.count}</td>
      <td class="num-cell">${t.nights}</td>
    </tr>`;
  }).join('\n');

  return `<table class="tag-table">
    <thead><tr><th>Tag</th><th>Frequency</th><th>Count</th><th>Nights</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function wrapRemHtml(graph: RemGraph): string {
  const dateRange = graph.nights.length
    ? `${graph.nights[0].date} → ${graph.nights[graph.nights.length - 1].date}`
    : '—';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rem — Aura Dream Graph</title>
<style>
  :root {
    --bg: #fdf6f0; --card: #fffaf5; --text: #3e2f24; --muted: #8a7768;
    --accent: #cc785c; --accent-2: #5a9e6e; --border: #e8d5c8;
    --code-bg: #f4ede6; --hr: #e0cebc;
    --shadow: 0 2px 12px rgba(62,47,36,0.06); --radius: 12px;
    --serif: 'Georgia', 'Times New Roman', serif;
    --sans: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    --mono: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1e1b18; --card: #26221e; --text: #ede0cc; --muted: #9e8e80;
      --accent: #e08a6e; --accent-2: #6db880; --border: #3a322a;
      --code-bg: #2c2722; --hr: #3a322a;
      --shadow: 0 2px 12px rgba(0,0,0,0.25);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--serif); line-height: 1.7; font-size: 17px; }
  .container { max-width: 980px; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
  .hero { text-align: center; padding: 2.5rem 0 2rem; border-bottom: 2px solid var(--border); margin-bottom: 2.5rem; }
  .hero .badge { display: inline-block; background: var(--accent); color: #fff; font-family: var(--sans); font-size: 0.7rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; padding: 0.3em 1em; border-radius: 100px; margin-bottom: 1.25rem; }
  .hero h1 { font-family: var(--sans); font-size: 2.2rem; font-weight: 700; line-height: 1.25; letter-spacing: -0.02em; margin-bottom: 0.5rem; }
  .hero .meta { font-family: var(--sans); font-size: 0.85rem; color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 2rem 2.5rem; margin-bottom: 2rem; }
  @media (max-width: 720px) { .card { padding: 1.25rem; border-radius: 8px; } .hero h1 { font-size: 1.6rem; } .container { padding: 1.5rem 0.75rem 3rem; } }
  .card h2 { font-family: var(--sans); font-size: 1.3rem; color: var(--accent); border-bottom: 2px solid var(--border); padding-bottom: 0.5rem; margin-bottom: 1.25rem; }
  .rem-graph { width: 100%; height: auto; display: block; }
  .night-circle { fill: var(--card); stroke: var(--accent); stroke-width: 2; }
  .night-label { font-family: var(--sans); font-size: 12px; font-weight: 700; fill: var(--text); }
  .night-sub, .tag-sub { font-family: var(--sans); font-size: 10px; fill: var(--muted); }
  .tag-label { font-family: var(--sans); font-size: 11px; font-weight: 600; }
  .tag-table { width: 100%; border-collapse: collapse; font-family: var(--sans); font-size: 0.9rem; }
  .tag-table th { text-align: left; color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; padding: 0.5rem 0.75rem; border-bottom: 2px solid var(--border); }
  .tag-table td { padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--hr); vertical-align: middle; }
  .tag-cell { white-space: nowrap; font-weight: 600; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 0.5em; }
  .num-cell { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
  .bar-track { background: var(--code-bg); border-radius: 6px; height: 8px; overflow: hidden; min-width: 100px; }
  .bar-fill { height: 100%; border-radius: 6px; }
  .footer { text-align: center; margin-top: 1rem; font-family: var(--sans); font-size: 0.8rem; color: var(--muted); opacity: 0.7; }
  .empty { text-align: center; color: var(--muted); font-family: var(--sans); padding: 3rem 1rem; }
</style>
</head>
<body>
<div class="container">
  <header class="hero">
    <div class="badge">Aura &middot; Rem</div>
    <h1>Dream Relations Graph</h1>
    <div class="meta">${esc(dateRange)} &middot; ${graph.nights.length} night(s) &middot; ${graph.topTags.length} tag(s)</div>
  </header>

  ${graph.nights.length === 0
    ? '<div class="card"><p class="empty">No dreams yet. Run :dream after some work, then :rem --html again.</p></div>'
    : `<section class="card">
    <h2>Nights &middot; Tags</h2>
    ${buildSvg(graph)}
  </section>

  <section class="card">
    <h2>What keeps coming up</h2>
    ${buildTopTagsTable(graph)}
  </section>`}

  <footer class="footer"><p>Generated by Aura Code &middot; :rem &middot; parsed from dreams/*.md</p></footer>
</div>
</body>
</html>`;
}
