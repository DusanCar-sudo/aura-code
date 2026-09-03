#!/usr/bin/env node
/**
 * Splice the 8 relation-graph panels (panels.js) into graphify-out/dashboard.html.
 * Idempotent — safe to run after every dashboard regeneration.
 * Run enrich-data.mjs first so DATA has metrics/git/agent fields.
 *
 * Usage: node graphify-out/add-panels.mjs [project-root]
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] || join(here, '..'));
const dash = join(root, 'graphify-out', 'dashboard.html');
const js = readFileSync(join(here, 'panels.js'), 'utf8');
let html = readFileSync(dash, 'utf8');

function splice(anchor, insert, where = 'after') {
  const i = html.indexOf(anchor);
  if (i < 0) throw new Error('anchor not found: ' + anchor.slice(0, 60));
  const at = where === 'after' ? i + anchor.length : i;
  html = html.slice(0, at) + insert + html.slice(at);
}

let did = 0;

if (!html.includes('d3-sankey')) {
  splice('<script src="https://d3js.org/d3.v7.min.js"></script>',
    '\n<script src="https://cdn.jsdelivr.net/npm/d3-sankey@0.12.3/dist/d3-sankey.min.js"></script>');
  did++;
}

if (!html.includes('.viz-svg')) {
  splice('  ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }', `
  /* relation-graph panels */
  nav { flex-wrap: wrap; }
  .viz-svg { background: var(--canvas); border: 1px solid var(--border); border-radius: 8px; flex: 1; min-height: 0; width: 100%; }
  .viz-wrap { background: var(--canvas); border: 1px solid var(--border); border-radius: 8px; flex: 1; min-height: 0; overflow: auto; }
  .viz-wrap svg { display: block; }`);
  did++;
}

if (!html.includes("showPanel('bundling'")) {
  splice(`<button onclick="showPanel('tools',this)">Tool Usage</button>`, `
  <button onclick="showPanel('bundling',this)">◉ Bundling</button>
  <button onclick="showPanel('chord',this)">◔ Chord</button>
  <button onclick="showPanel('arc',this)">◠ Arc</button>
  <button onclick="showPanel('matrix',this)">▦ Matrix</button>
  <button onclick="showPanel('sankey',this)">⇶ Sankey</button>
  <button onclick="showPanel('radial',this)">✳ Radial</button>
  <button onclick="showPanel('particles',this)">✦ Particles</button>
  <button onclick="showPanel('hulls',this)">◍ Hulls</button>`);
  did++;
}

if (!html.includes('id="bundling"')) {
  splice(`<div id="tools"       class="panel"></div>`, `
<div id="bundling"    class="panel"></div>
<div id="chord"       class="panel"></div>
<div id="arc"         class="panel"></div>
<div id="matrix"      class="panel"></div>
<div id="sankey"      class="panel"></div>
<div id="radial"      class="panel"></div>
<div id="particles"   class="panel"></div>
<div id="hulls"       class="panel"></div>`);
  did++;
}

if (!html.includes('AURA_X.open')) {
  splice(`  if (id === 'tools'       && !toolsInit) initTools();`,
    `\n  if (window.AURA_X) AURA_X.open(id);`);
  did++;
}

if (!html.includes('AURA_X = {')) {
  splice('</body>', '<script>\n' + js + '</script>\n', 'before');
  did++;
}

writeFileSync(dash, html, 'utf8');
console.log(did ? `  ✓ panels spliced (${did} sections) — dashboard.html now ${html.length} bytes`
                : '  ✓ panels already present — nothing to do');
