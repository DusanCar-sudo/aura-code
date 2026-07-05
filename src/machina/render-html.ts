import { AAM_PREAMBLE, AAM_LIMITS_NOTE } from './spec.js';
import type { VerificationReport, ClaimResult } from './verify.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const COMPONENT_LABEL: Record<ClaimResult['component'], string> = {
  S: 'S — state space',
  P: 'P — primitives',
  O: 'O — oracle',
  delta: 'δ — transition',
  s0: 's₀ — initial state',
  limit: 'limit / invariant',
};

/**
 * A static SVG of the AAM tuple: s₀ feeding the loop, δ consulting O each
 * iteration, gated by the safety check, looping back into S, with the
 * compaction/maxTurns limits drawn as a boundary around the whole loop.
 * Deliberately diagrammatic rather than data-driven (there is exactly one
 * AAM, not a variable-size collection like the :rem graph) — fixed layout,
 * no dependency on claim count.
 */
function buildTupleSvg(): string {
  return `<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="machina-graph">
  <rect x="40" y="30" width="680" height="260" rx="16" class="bound-box" />
  <text x="60" y="58" class="bound-label">finite machine — maxTurns, context compaction</text>

  <circle cx="140" cy="180" r="46" class="node s0-node" />
  <text x="140" y="175" class="node-label" text-anchor="middle">s₀</text>
  <text x="140" y="193" class="node-sub" text-anchor="middle">task + ∅</text>

  <circle cx="330" cy="180" r="50" class="node delta-node" />
  <text x="330" y="174" class="node-label" text-anchor="middle">δ</text>
  <text x="330" y="192" class="node-sub" text-anchor="middle">transition</text>

  <circle cx="540" cy="100" r="42" class="node oracle-node" />
  <text x="540" y="95" class="node-label" text-anchor="middle">O</text>
  <text x="540" y="113" class="node-sub" text-anchor="middle">oracle</text>

  <circle cx="540" cy="260" r="38" class="node safety-node" />
  <text x="540" y="256" class="node-label" text-anchor="middle">safety</text>
  <text x="540" y="272" class="node-sub" text-anchor="middle">gate</text>

  <line x1="186" y1="180" x2="280" y2="180" class="edge edge-start" marker-end="url(#arrow)" />
  <line x1="372" y1="160" x2="498" y2="110" class="edge edge-oracle" marker-end="url(#arrow)" />
  <line x1="500" y1="130" x2="378" y2="172" class="edge edge-oracle-back" marker-end="url(#arrow)" />
  <line x1="375" y1="195" x2="502" y2="245" class="edge edge-safety" marker-end="url(#arrow)" />
  <line x1="505" y1="230" x2="378" y2="190" class="edge edge-safety-back" marker-end="url(#arrow)" />
  <path d="M 330 230 C 330 290, 220 290, 175 215" class="edge edge-loop" marker-end="url(#arrow)" fill="none" />
  <text x="250" y="305" class="loop-label">loop: s′ → s, until done or T_max</text>

  <defs>
    <marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" class="arrow-head" />
    </marker>
  </defs>
</svg>`;
}

function buildClaimsTable(report: VerificationReport): string {
  const rows = report.results.map(r => {
    const ok = r.status === 'verified';
    const cls = ok ? 'ok' : (r.status === 'drifted' ? 'drift' : 'missing');
    const glyph = ok ? '✓' : (r.status === 'drifted' ? '⚠' : '✗');
    return `<tr class="${cls}">
      <td class="glyph">${glyph}</td>
      <td class="comp">${esc(COMPONENT_LABEL[r.component])}</td>
      <td class="loc"><code>${esc(r.file)}:${r.line}</code></td>
      <td class="desc">${esc(r.description)}</td>
    </tr>`;
  }).join('\n');

  return `<table class="claims-table">
    <thead><tr><th></th><th>Component</th><th>Location</th><th>What's grounded there</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function wrapMachinaHtml(report: VerificationReport): string {
  const allOk = report.drifted.length === 0 && report.missing.length === 0;
  const statusLine = allOk
    ? `All ${report.verifiedCount} structural claims verified against the current source.`
    : `${report.verifiedCount}/${report.results.length} verified — ${report.drifted.length} drifted, ${report.missing.length} missing.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Machina — the Abstract Agent Machine</title>
<style>
  :root {
    --bg: #fdf6f0; --card: #fffaf5; --text: #3e2f24; --muted: #8a7768;
    --accent: #cc785c; --accent-2: #5a9e6e; --accent-3: #9e6ecc; --border: #e8d5c8;
    --code-bg: #f4ede6; --hr: #e0cebc; --warn: #b15439;
    --shadow: 0 2px 12px rgba(62,47,36,0.06); --radius: 12px;
    --serif: 'Georgia', 'Times New Roman', serif;
    --sans: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    --mono: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1e1b18; --card: #26221e; --text: #ede0cc; --muted: #9e8e80;
      --accent: #e08a6e; --accent-2: #6db880; --accent-3: #b48ee0; --border: #3a322a;
      --code-bg: #2c2722; --hr: #3a322a; --warn: #e0876e;
      --shadow: 0 2px 12px rgba(0,0,0,0.25);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--serif); line-height: 1.75; font-size: 18px; }
  .container { max-width: 860px; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
  .hero { text-align: center; padding: 2.5rem 0 2rem; border-bottom: 2px solid var(--border); margin-bottom: 2.5rem; }
  .hero .badge { display: inline-block; background: var(--accent-3); color: #fff; font-family: var(--sans); font-size: 0.7rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; padding: 0.3em 1em; border-radius: 100px; margin-bottom: 1.25rem; }
  .hero h1 { font-family: var(--sans); font-size: 2.2rem; font-weight: 700; line-height: 1.25; letter-spacing: -0.02em; margin-bottom: 0.5rem; }
  .hero .meta { font-family: var(--sans); font-size: 0.85rem; color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 2.25rem 2.75rem; margin-bottom: 2rem; }
  @media (max-width: 700px) { .card { padding: 1.25rem; border-radius: 8px; } .hero h1 { font-size: 1.6rem; } .container { padding: 1.5rem 0.75rem 3rem; } }
  .card h2 { font-family: var(--sans); font-size: 1.3rem; color: var(--accent); border-bottom: 2px solid var(--border); padding-bottom: 0.5rem; margin-bottom: 1.25rem; }
  .tuple { font-family: var(--mono); font-size: 1.3rem; text-align: center; color: var(--accent-3); margin: 1rem 0 1.5rem; }
  .tuple-defs { font-family: var(--sans); font-size: 0.95rem; }
  .tuple-defs dt { font-weight: 700; color: var(--accent); float: left; width: 2.4rem; }
  .tuple-defs dd { margin: 0 0 0.75rem 2.4rem; color: var(--text); }
  .machina-graph { width: 100%; height: auto; display: block; margin: 1rem 0; }
  .bound-box { fill: none; stroke: var(--border); stroke-width: 2; stroke-dasharray: 6 5; }
  .bound-label { font-family: var(--sans); font-size: 11px; fill: var(--muted); }
  .node { stroke-width: 2; fill: var(--card); }
  .s0-node { stroke: var(--accent-2); }
  .delta-node { stroke: var(--accent); }
  .oracle-node { stroke: var(--accent-3); }
  .safety-node { stroke: var(--warn); }
  .node-label { font-family: var(--sans); font-size: 16px; font-weight: 700; fill: var(--text); }
  .node-sub { font-family: var(--sans); font-size: 10px; fill: var(--muted); }
  .edge { stroke: var(--muted); stroke-width: 1.6; opacity: 0.7; }
  .edge-loop { stroke: var(--accent); stroke-width: 2; }
  .arrow-head { fill: var(--muted); }
  .loop-label { font-family: var(--sans); font-size: 11px; fill: var(--muted); }
  p.prose { font-family: var(--sans); font-size: 1rem; color: var(--text); margin-bottom: 0.75rem; }
  .claims-table { width: 100%; border-collapse: collapse; font-family: var(--sans); font-size: 0.88rem; }
  .claims-table th { text-align: left; color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; padding: 0.5rem 0.6rem; border-bottom: 2px solid var(--border); }
  .claims-table td { padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--hr); vertical-align: top; }
  .claims-table .glyph { width: 1.5rem; text-align: center; }
  .claims-table tr.ok .glyph { color: var(--accent-2); }
  .claims-table tr.drift .glyph, .claims-table tr.missing .glyph { color: var(--warn); }
  .claims-table code { font-family: var(--mono); font-size: 0.82em; background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; }
  .status-line { font-family: var(--sans); font-weight: 600; padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1.25rem; }
  .status-line.ok { background: color-mix(in srgb, var(--accent-2) 15%, transparent); color: var(--accent-2); }
  .status-line.warn { background: color-mix(in srgb, var(--warn) 15%, transparent); color: var(--warn); }
  .footer { text-align: center; margin-top: 1rem; font-family: var(--sans); font-size: 0.8rem; color: var(--muted); opacity: 0.7; }
</style>
</head>
<body>
<div class="container">
  <header class="hero">
    <div class="badge">Aura &middot; Machina</div>
    <h1>The Abstract Agent Machine</h1>
    <div class="meta">A formal model of what aura-code is, independent of which oracle is plugged in</div>
  </header>

  <section class="card">
    <p class="prose">${esc(AAM_PREAMBLE)}</p>
    <div class="tuple">AAM = (S, P, O, δ, s₀)</div>
    <dl class="tuple-defs">
      <dt>S</dt><dd>State space — conversation history plus loop counters. Every run lives inside S.</dd>
      <dt>P</dt><dd>Primitives — the finite, fixed set of tool calls the machine can invoke. Finite and enumerable.</dd>
      <dt>O</dt><dd>The oracle — the only swappable part of the tuple. LLM, human, rule table, or another AAM run recursively. Swapping O leaves S, P, δ, s₀ unchanged.</dd>
      <dt>δ</dt><dd>Transition function — δ(s, O(s)) → s′: consult the oracle, run its output through the safety gate, execute tool calls against P, fold results into history.</dd>
      <dt>s₀</dt><dd>Initial state — empty history plus the user's task as the first message.</dd>
    </dl>
  </section>

  <section class="card">
    <h2>The loop, diagrammed</h2>
    ${buildTupleSvg()}
  </section>

  <section class="card">
    <h2>Grounding — verified against the live source</h2>
    <div class="status-line ${allOk ? 'ok' : 'warn'}">${esc(statusLine)}</div>
    ${buildClaimsTable(report)}
  </section>

  <section class="card">
    <h2>Why "unlimited" has a price</h2>
    <p class="prose">${esc(AAM_LIMITS_NOTE)}</p>
  </section>

  <footer class="footer"><p>Generated by Aura Code &middot; :machina &middot; claims verified against the checked-out source tree</p></footer>
</div>
</body>
</html>`;
}
