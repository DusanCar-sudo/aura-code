// ── 8 relation-graph panels (bundling, chord, arc, matrix, sankey, radial, particles, hulls)
(function () {
'use strict';
const M  = DATA.metrics || {};
const WE = DATA.weightedEdges || [];
const CC = DATA.coChange || [];
const AG = DATA.agent || { sessions: [], toolTotals: {}, toolTransitions: [], fileTouches: {}, topCommands: [], commands: [], spawns: [], questions: [] };

const FILES = (DATA.graph ? DATA.graph.nodes : []).filter(n => n.type === 'file' && n.file).map(n => n.file);
const FILESET = new Set(FILES);
const FF  = WE.filter(e => FILESET.has(e.source) && FILESET.has(e.target));   // file→file imports
const CCF = CC.filter(e => FILESET.has(e.a) && FILESET.has(e.b));             // co-change pairs

function groupOf(f) {
  const p = f.split('/');
  if (p[0] === 'src' && p.length > 2) return 'src/' + p[1];
  return p.length > 1 ? p[0] : '(root)';
}
const PAL = ['#58a6ff','#f0883e','#bc8cff','#3fb950','#d29922','#ff7b72','#39c5cf','#d2a8ff','#56d364','#e3b341','#79c0ff','#ffa657'];
const gCount = {};
FILES.forEach(f => { const g = groupOf(f); gCount[g] = (gCount[g] || 0) + 1; });
const GROUPS = Object.keys(gCount).sort((a, b) => gCount[b] - gCount[a]);
const GC = {};
GROUPS.forEach((g, i) => { GC[g] = i < PAL.length ? PAL[i] : '#8b949e'; });
const gIdx = {};
GROUPS.forEach((g, i) => gIdx[g] = i);
const colorOf = f => GC[groupOf(f)] || '#8b949e';
const base = f => f.split('/').pop();

// tooltip
const tipEl = document.getElementById('tooltip');
function tipShow(html, ev) { tipEl.style.display = 'block'; tipEl.innerHTML = html; tipMove(ev); }
function tipMove(ev) {
  const x = Math.min(ev.clientX + 14, innerWidth - 320), y = Math.min(ev.clientY + 12, innerHeight - 160);
  tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
}
function tipHide() { tipEl.style.display = 'none'; }
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const kb = b => b > 1024 ? (b / 1024).toFixed(1) + ' KB' : b + ' B';

function fileTip(f) {
  const m = M[f] || {};
  let h = `<strong>${esc(f)}</strong><br><span class="t-type">${esc(groupOf(f))}</span><br>`;
  if (m.loc) h += `${m.loc} lines · ${kb(m.bytes || 0)} · ${m.exports || 0} exports<br>`;
  if (m.churn) h += `<span style="color:var(--amber)">⟳ ${m.churn} commits</span> · last: ${esc(m.lastDate || '')}<br><span style="color:var(--muted)">${esc((m.lastSubject || '').slice(0, 60))}</span><br>`;
  if (m.agentReads || m.agentWrites) h += `<span style="color:var(--success)">agent: ${m.agentReads || 0} reads, ${m.agentWrites || 0} writes</span>`;
  return h;
}
function legendHtml(groups) {
  return '<div class="legend">' + groups.slice(0, 12).map(g =>
    `<span class="legend-item on" style="color:${GC[g]}"><span class="legend-dot" style="background:${GC[g]}"></span>${esc(g)}</span>`).join('') + '</div>';
}
function modeBar(id, modes, active) {
  return '<div class="mode-toggle">' + modes.map(m =>
    `<button class="mode-btn${m.k === active ? ' active' : ''}" data-mode="${m.k}" data-panel="${id}">${m.label}</button>`).join('') + '</div>';
}
function wireModes(panel, onMode) {
  panel.querySelectorAll('.mode-btn').forEach(b => b.addEventListener('click', () => {
    panel.querySelectorAll('.mode-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    onMode(b.dataset.mode);
  }));
}
function svgSize(sel) { const r = sel.node().getBoundingClientRect(); return [r.width, r.height]; }
const polar = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

// ═══ 1. HIERARCHICAL EDGE BUNDLING ═══════════════════════════════════════════
function initBundling() {
  const panel = document.getElementById('bundling');
  const deg = {};
  FF.forEach(e => { deg[e.source] = (deg[e.source] || 0) + e.w; deg[e.target] = (deg[e.target] || 0) + e.w; });
  const nodes = FILES.filter(f => deg[f]).sort((a, b) => (gIdx[groupOf(a)] - gIdx[groupOf(b)]) || a.localeCompare(b));
  panel.innerHTML = `<div class="graph-controls">
      <input id="bundling-search" placeholder="highlight files…">
      ${legendHtml([...new Set(nodes.map(groupOf))])}
      <span class="hint">hover a file: orange = it imports, blue = imports it · dot size = lines of code · red ring = high churn</span>
    </div><svg id="bundling-svg" class="viz-svg"></svg>`;
  const svg = d3.select('#bundling-svg');
  const [w, h] = svgSize(svg);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 118;
  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.5, 6]).on('zoom', ev => g.attr('transform', ev.transform)));

  const present = [...new Set(nodes.map(groupOf))];
  const slots = nodes.length + present.length * 3;
  const pos = {}; let slot = 0; let prevG = null;
  nodes.forEach(f => {
    const gr = groupOf(f);
    if (gr !== prevG) { slot += 3; prevG = gr; }
    const a = -Math.PI / 2 + (slot / slots) * 2 * Math.PI;
    pos[f] = { a, p: polar(cx, cy, R, a) };
    slot++;
  });

  const edgeSel = g.append('g').selectAll('path').data(FF).join('path')
    .attr('d', e => {
      const A = pos[e.source], B = pos[e.target];
      const c1 = polar(cx, cy, R * 0.18, A.a), c2 = polar(cx, cy, R * 0.18, B.a);
      return `M${A.p[0]},${A.p[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${B.p[0]},${B.p[1]}`;
    })
    .attr('fill', 'none')
    .attr('stroke', e => colorOf(e.source))
    .attr('stroke-width', e => 0.6 + Math.sqrt(e.w) * 0.6)
    .attr('opacity', 0.28);

  const nodeSel = g.append('g').selectAll('circle').data(nodes).join('circle')
    .attr('cx', f => pos[f].p[0]).attr('cy', f => pos[f].p[1])
    .attr('r', f => 2.5 + Math.min(5, Math.sqrt((M[f] || {}).loc || 10) / 5))
    .attr('fill', colorOf)
    .attr('stroke', f => ((M[f] || {}).churn || 0) >= 3 ? '#f85149' : '#1c2128')
    .attr('stroke-width', f => ((M[f] || {}).churn || 0) >= 3 ? 2 : 1);

  const labelSel = g.append('g').selectAll('text').data(nodes).join('text')
    .text(f => base(f).slice(0, 26))
    .attr('font-size', 8).attr('fill', 'var(--muted)')
    .attr('transform', f => {
      const deg_ = pos[f].a * 180 / Math.PI, flip = deg_ > 90 || deg_ < -90;
      return `translate(${cx},${cy}) rotate(${deg_}) translate(${R + 9},0)` + (flip ? ' rotate(180)' : '');
    })
    .attr('text-anchor', f => { const d = pos[f].a * 180 / Math.PI; return (d > 90 || d < -90) ? 'end' : 'start'; })
    .attr('dominant-baseline', 'middle');

  function focus(f) {
    edgeSel.attr('stroke', e => e.source === f ? '#f0883e' : e.target === f ? '#58a6ff' : colorOf(e.source))
      .attr('opacity', e => (e.source === f || e.target === f) ? 0.95 : 0.04);
    const near = new Set([f]);
    FF.forEach(e => { if (e.source === f) near.add(e.target); if (e.target === f) near.add(e.source); });
    nodeSel.attr('opacity', n => near.has(n) ? 1 : 0.15);
    labelSel.attr('fill', n => n === f ? 'var(--primary)' : near.has(n) ? 'var(--text)' : 'var(--dim)')
      .attr('font-weight', n => near.has(n) ? 700 : 400)
      .attr('opacity', n => near.has(n) ? 1 : 0.3);
  }
  function unfocus() {
    edgeSel.attr('stroke', e => colorOf(e.source)).attr('opacity', 0.28);
    nodeSel.attr('opacity', 1);
    labelSel.attr('fill', 'var(--muted)').attr('font-weight', 400).attr('opacity', 1);
  }
  nodeSel.on('mouseover', (ev, f) => { focus(f); tipShow(fileTip(f), ev); })
    .on('mousemove', (ev) => tipMove(ev))
    .on('mouseout', () => { unfocus(); tipHide(); });
  labelSel.style('cursor', 'default')
    .on('mouseover', (ev, f) => { focus(f); tipShow(fileTip(f), ev); })
    .on('mouseout', () => { unfocus(); tipHide(); });

  document.getElementById('bundling-search').addEventListener('input', ev => {
    const q = ev.target.value.toLowerCase();
    if (!q) return unfocus();
    labelSel.attr('fill', f => f.toLowerCase().includes(q) ? 'var(--primary)' : 'var(--dim)')
      .attr('font-weight', f => f.toLowerCase().includes(q) ? 700 : 400);
    nodeSel.attr('opacity', f => f.toLowerCase().includes(q) ? 1 : 0.2);
    edgeSel.attr('opacity', e => (e.source.toLowerCase().includes(q) || e.target.toLowerCase().includes(q)) ? 0.7 : 0.05);
  });
}

// ═══ 2. CHORD ════════════════════════════════════════════════════════════════
function initChord() {
  const panel = document.getElementById('chord');
  panel.innerHTML = `<div class="graph-controls">
      ${modeBar('chord', [{k:'imports',label:'Module imports'},{k:'cochange',label:'Git co-change'},{k:'tools',label:'Agent tool flow'}], 'imports')}
      <span class="hint" id="chord-hint"></span>
    </div><svg id="chord-svg" class="viz-svg"></svg>`;
  const svg = d3.select('#chord-svg');
  const [w, h] = svgSize(svg);
  const R = Math.min(w, h) / 2 - 110;

  function build(mode) {
    let keys, mat, colors, hint;
    if (mode === 'tools') {
      const totals = AG.toolTotals || {};
      keys = Object.keys(totals).sort((a, b) => totals[b] - totals[a]).slice(0, 12);
      const ix = Object.fromEntries(keys.map((k, i) => [k, i]));
      mat = keys.map(() => keys.map(() => 0));
      (AG.toolTransitions || []).forEach(t => { if (ix[t.from] != null && ix[t.to] != null) mat[ix[t.from]][ix[t.to]] += t.w; });
      colors = keys.map((k, i) => PAL[i % PAL.length]);
      hint = 'which tool the agent used next: A → B ribbons from ' + (AG.sessions || []).length + ' sessions';
    } else {
      const agg = new Map();
      if (mode === 'imports') FF.forEach(e => {
        const a = groupOf(e.source), b = groupOf(e.target);
        if (a === b) return;
        const k = a + '\t' + b; agg.set(k, (agg.get(k) || 0) + e.w);
      });
      else CCF.forEach(e => {
        const a = groupOf(e.a), b = groupOf(e.b);
        if (a === b) return;
        agg.set(a + '\t' + b, (agg.get(a + '\t' + b) || 0) + e.w);
        agg.set(b + '\t' + a, (agg.get(b + '\t' + a) || 0) + e.w);
      });
      const flow = {};
      agg.forEach((v, k) => k.split('\t').forEach(g => flow[g] = (flow[g] || 0) + v));
      keys = Object.keys(flow).sort((a, b) => flow[b] - flow[a]).slice(0, 14);
      const ix = Object.fromEntries(keys.map((k, i) => [k, i]));
      mat = keys.map(() => keys.map(() => 0));
      agg.forEach((v, k) => { const [a, b] = k.split('\t'); if (ix[a] != null && ix[b] != null) mat[ix[a]][ix[b]] = v; });
      colors = keys.map(k => GC[k] || '#8b949e');
      hint = mode === 'imports' ? 'ribbon width = number of import statements between modules'
                                : 'ribbon width = times files of the two modules were committed together';
    }
    document.getElementById('chord-hint').textContent = hint;
    svg.selectAll('*').remove();
    if (!keys.length) { svg.append('text').attr('x', w/2).attr('y', h/2).attr('fill', 'var(--dim)').attr('text-anchor','middle').text('no data'); return; }
    const g = svg.append('g').attr('transform', `translate(${w / 2},${h / 2})`);
    const chords = d3.chord().padAngle(0.045).sortSubgroups(d3.descending)(mat);
    const arc = d3.arc().innerRadius(R).outerRadius(R + 12);
    const ribbon = d3.ribbon().radius(R - 2);

    const grpSel = g.append('g').selectAll('g').data(chords.groups).join('g');
    grpSel.append('path').attr('d', arc).attr('fill', d => colors[d.index]);
    grpSel.append('text')
      .attr('transform', d => {
        const a = (d.startAngle + d.endAngle) / 2 - Math.PI / 2;
        const flip = a > Math.PI / 2;
        return `rotate(${a * 180 / Math.PI}) translate(${R + 18},0)` + (flip ? ' rotate(180)' : '');
      })
      .attr('text-anchor', d => ((d.startAngle + d.endAngle) / 2 - Math.PI / 2) > Math.PI / 2 ? 'end' : 'start')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', 10).attr('fill', 'var(--text)')
      .text(d => keys[d.index]);

    const ribSel = g.append('g').selectAll('path').data(chords).join('path')
      .attr('d', ribbon)
      .attr('fill', d => colors[d.source.index]).attr('opacity', 0.55)
      .attr('stroke', '#0d1117').attr('stroke-width', 0.5);
    ribSel.on('mouseover', (ev, d) => {
      ribSel.attr('opacity', x => x === d ? 0.95 : 0.07);
      const unit = mode === 'imports' ? 'imports' : mode === 'cochange' ? 'co-commits' : 'times';
      let html = `<strong>${esc(keys[d.source.index])}</strong> → <strong>${esc(keys[d.target.index])}</strong><br>${d.source.value} ${unit}`;
      if (d.target.value && d.target.index !== d.source.index) html += `<br>← ${d.target.value} ${unit} back`;
      tipShow(html, ev);
    }).on('mousemove', tipMove).on('mouseout', () => { ribSel.attr('opacity', 0.55); tipHide(); });
    grpSel.on('mouseover', (ev, d) => {
      ribSel.attr('opacity', x => (x.source.index === d.index || x.target.index === d.index) ? 0.9 : 0.07);
      tipShow(`<strong>${esc(keys[d.index])}</strong><br>total flow: ${d.value}`, ev);
    }).on('mousemove', tipMove).on('mouseout', () => { ribSel.attr('opacity', 0.55); tipHide(); });
  }
  wireModes(panel, build);
  build('imports');
}

// ═══ 3. ARC DIAGRAM ══════════════════════════════════════════════════════════
function initArc() {
  const panel = document.getElementById('arc');
  panel.innerHTML = `<div class="graph-controls">
      ${modeBar('arc', [{k:'imports',label:'Imports'},{k:'cochange',label:'Git co-change'}], 'imports')}
      <input id="arc-search" placeholder="highlight files…">
      <span class="hint">arc width = strength · long high arcs = long-range coupling · dot size = LOC</span>
    </div><div class="viz-wrap" id="arc-wrap"></div>`;
  const wrap = document.getElementById('arc-wrap');
  const H = wrap.getBoundingClientRect().height || 500;

  function build(mode) {
    wrap.innerHTML = '';
    const edges = mode === 'imports'
      ? FF.map(e => ({ a: e.source, b: e.target, w: e.w }))
      : CCF.map(e => ({ a: e.a, b: e.b, w: e.w }));
    const deg = {};
    edges.forEach(e => { deg[e.a] = (deg[e.a] || 0) + e.w; deg[e.b] = (deg[e.b] || 0) + e.w; });
    const nodes = FILES.filter(f => deg[f]).sort((a, b) => (gIdx[groupOf(a)] - gIdx[groupOf(b)]) || a.localeCompare(b));
    const ix = Object.fromEntries(nodes.map((f, i) => [f, i]));
    const step = 11, mL = 30;
    const W = Math.max(wrap.getBoundingClientRect().width - 2, nodes.length * step + mL * 2);
    const baseY = H - 130;
    const svg = d3.select(wrap).append('svg').attr('width', W).attr('height', H - 2);
    const X = i => mL + i * step;

    const maxH = baseY - 24;
    const arcSel = svg.append('g').selectAll('path').data(edges).join('path')
      .attr('d', e => {
        const x1 = X(Math.min(ix[e.a], ix[e.b])), x2 = X(Math.max(ix[e.a], ix[e.b]));
        const rx = (x2 - x1) / 2, ry = Math.min(rx * 0.9, maxH);
        return `M${x1},${baseY} A${rx},${ry} 0 0 1 ${x2},${baseY}`;
      })
      .attr('fill', 'none')
      .attr('stroke', e => colorOf(e.a))
      .attr('stroke-width', e => 0.7 + Math.sqrt(e.w) * 0.9)
      .attr('opacity', 0.38);

    const nodeSel = svg.append('g').selectAll('circle').data(nodes).join('circle')
      .attr('cx', f => X(ix[f])).attr('cy', baseY)
      .attr('r', f => 2.5 + Math.min(5.5, Math.sqrt((M[f] || {}).loc || 10) / 5))
      .attr('fill', colorOf)
      .attr('stroke', f => ((M[f] || {}).churn || 0) >= 3 ? '#f85149' : '#1c2128')
      .attr('stroke-width', f => ((M[f] || {}).churn || 0) >= 3 ? 2 : 1);

    const labSel = svg.append('g').selectAll('text').data(nodes).join('text')
      .text(f => base(f).slice(0, 24))
      .attr('font-size', 8).attr('fill', 'var(--muted)')
      .attr('transform', f => `translate(${X(ix[f]) + 3},${baseY + 12}) rotate(55)`);

    function focus(f) {
      arcSel.attr('opacity', e => (e.a === f || e.b === f) ? 0.95 : 0.05)
        .attr('stroke', e => e.a === f || e.b === f ? '#f0883e' : colorOf(e.a));
      const near = new Set([f]);
      edges.forEach(e => { if (e.a === f) near.add(e.b); if (e.b === f) near.add(e.a); });
      nodeSel.attr('opacity', n => near.has(n) ? 1 : 0.2);
      labSel.attr('fill', n => n === f ? 'var(--primary)' : near.has(n) ? 'var(--text)' : 'var(--dim)');
    }
    function unfocus() {
      arcSel.attr('opacity', 0.38).attr('stroke', e => colorOf(e.a));
      nodeSel.attr('opacity', 1); labSel.attr('fill', 'var(--muted)');
    }
    nodeSel.on('mouseover', (ev, f) => { focus(f); tipShow(fileTip(f), ev); })
      .on('mousemove', tipMove).on('mouseout', () => { unfocus(); tipHide(); });

    document.getElementById('arc-search').oninput = ev => {
      const q = ev.target.value.toLowerCase();
      if (!q) return unfocus();
      nodeSel.attr('opacity', f => f.toLowerCase().includes(q) ? 1 : 0.15);
      labSel.attr('fill', f => f.toLowerCase().includes(q) ? 'var(--primary)' : 'var(--dim)');
      arcSel.attr('opacity', e => (e.a.toLowerCase().includes(q) || e.b.toLowerCase().includes(q)) ? 0.8 : 0.04);
    };
  }
  wireModes(panel, build);
  build('imports');
}

// ═══ 4. ADJACENCY MATRIX ═════════════════════════════════════════════════════
function initMatrix() {
  const panel = document.getElementById('matrix');
  panel.innerHTML = `<div class="graph-controls">
      ${modeBar('matrix', [{k:'modules',label:'Modules'},{k:'files',label:'Top files'},{k:'cochange',label:'Co-change'},{k:'agent',label:'Sessions × files'}], 'modules')}
      <span class="hint" id="matrix-hint"></span>
    </div><div class="viz-wrap" id="matrix-wrap"></div>`;
  const wrap = document.getElementById('matrix-wrap');

  function build(mode) {
    wrap.innerHTML = '';
    let rows, cols, val, hint, unit;
    if (mode === 'modules') {
      const agg = new Map();
      FF.forEach(e => { const k = groupOf(e.source) + '\t' + groupOf(e.target); agg.set(k, (agg.get(k) || 0) + e.w); });
      const flow = {};
      agg.forEach((v, k) => k.split('\t').forEach(g => flow[g] = (flow[g] || 0) + v));
      rows = cols = Object.keys(flow).sort((a, b) => flow[b] - flow[a]);
      val = (r, c) => agg.get(r + '\t' + c) || 0;
      hint = 'row imports column — bright diagonal = intra-module cohesion, off-diagonal = coupling'; unit = 'imports';
    } else if (mode === 'files' || mode === 'cochange') {
      const edges = mode === 'files' ? FF.map(e => ({ a: e.source, b: e.target, w: e.w })) : CCF;
      const deg = {};
      edges.forEach(e => { deg[e.a] = (deg[e.a] || 0) + e.w; deg[e.b] = (deg[e.b] || 0) + e.w; });
      rows = cols = Object.keys(deg).sort((a, b) => deg[b] - deg[a]).slice(0, 56)
        .sort((a, b) => (gIdx[groupOf(a)] - gIdx[groupOf(b)]) || a.localeCompare(b));
      const m = new Map();
      edges.forEach(e => {
        m.set(e.a + '\t' + e.b, (m.get(e.a + '\t' + e.b) || 0) + e.w);
        if (mode === 'cochange') m.set(e.b + '\t' + e.a, (m.get(e.b + '\t' + e.a) || 0) + e.w);
      });
      val = (r, c) => m.get(r + '\t' + c) || 0;
      hint = mode === 'files' ? 'row imports column · top 56 files by import degree, grouped by module'
                              : 'files committed together (symmetric) · top 56 by co-change activity';
      unit = mode === 'files' ? 'imports' : 'co-commits';
    } else {
      const sess = (AG.sessions || []).filter(s => Object.keys(s.files || {}).length);
      const seen = {};
      sess.forEach(s => { const t = s.title; seen[t] = (seen[t] || 0) + 1; s._label = seen[t] > 1 ? t + ' (' + seen[t] + ')' : t; });
      const touch = {};
      sess.forEach(s => Object.entries(s.files).forEach(([f, c]) => touch[f] = (touch[f] || 0) + c));
      cols = Object.keys(touch).sort((a, b) => touch[b] - touch[a]).slice(0, 40);
      rows = sess.map(s => s._label);
      const m = new Map();
      sess.forEach(s => Object.entries(s.files).forEach(([f, c]) => m.set(s._label + '\t' + f, c)));
      val = (r, c) => m.get(r + '\t' + c) || 0;
      hint = 'which files each agent session touched (reads + writes) — the agent’s attention map'; unit = 'touches';
    }
    document.getElementById('matrix-hint').textContent = hint;
    if (!rows.length || !cols.length) { wrap.innerHTML = '<div class="empty">no data for this mode</div>'; return; }

    const rect = wrap.getBoundingClientRect();
    const labW = mode === 'agent' ? 230 : mode === 'modules' ? 150 : 190;
    const labH = mode === 'modules' ? 120 : 150;
    const cs = Math.max(6, Math.min(24, Math.floor(Math.min((rect.width - labW - 20) / cols.length, (rect.height - labH - 20) / rows.length))));
    const W = labW + cols.length * cs + 20, H = labH + rows.length * cs + 20;
    const svg = d3.select(wrap).append('svg').attr('width', Math.max(W, rect.width - 2)).attr('height', Math.max(H, rect.height - 2));
    const g = svg.append('g').attr('transform', `translate(${labW},${labH})`);
    let vmax = 0;
    rows.forEach(r => cols.forEach(c => vmax = Math.max(vmax, val(r, c))));

    const rlab = r => mode === 'agent' ? r.slice(0, 34) : (r.includes('/') && mode !== 'modules' ? base(r) : r).slice(0, 28);
    g.append('g').selectAll('text').data(rows).join('text')
      .text(rlab).attr('x', -8).attr('y', (r, i) => i * cs + cs / 2)
      .attr('text-anchor', 'end').attr('dominant-baseline', 'middle')
      .attr('font-size', Math.min(10, cs - 1))
      .attr('fill', r => mode === 'agent' ? 'var(--muted)' : (GC[mode === 'modules' ? r : groupOf(r)] || 'var(--muted)'));
    g.append('g').selectAll('text').data(cols).join('text')
      .text(c => (c.includes('/') && mode !== 'modules' ? base(c) : c).slice(0, 26))
      .attr('transform', (c, i) => `translate(${i * cs + cs / 2},-8) rotate(-55)`)
      .attr('font-size', Math.min(10, cs - 1))
      .attr('fill', c => GC[mode === 'modules' ? c : groupOf(c)] || 'var(--muted)');

    // faint grid
    g.append('g').selectAll('line.h').data(rows).join('line')
      .attr('x1', 0).attr('x2', cols.length * cs).attr('y1', (r, i) => i * cs).attr('y2', (r, i) => i * cs)
      .attr('stroke', '#30363d').attr('stroke-width', 0.4);
    g.append('g').selectAll('line.v').data(cols).join('line')
      .attr('y1', 0).attr('y2', rows.length * cs).attr('x1', (c, i) => i * cs).attr('x2', (c, i) => i * cs)
      .attr('stroke', '#30363d').attr('stroke-width', 0.4);

    const cells = [];
    rows.forEach((r, i) => cols.forEach((c, j) => { const v = val(r, c); if (v) cells.push({ r, c, i, j, v }); }));
    g.append('g').selectAll('rect').data(cells).join('rect')
      .attr('x', d => d.j * cs + 1).attr('y', d => d.i * cs + 1)
      .attr('width', cs - 2).attr('height', cs - 2).attr('rx', Math.min(3, cs / 5))
      .attr('fill', d => (mode !== 'modules' && d.r === d.c) ? '#30363d' : '#f0883e')
      .attr('opacity', d => 0.25 + 0.75 * Math.sqrt(d.v / vmax))
      .on('mouseover', (ev, d) => tipShow(`<strong>${esc(rlab(d.r))}</strong> ${mode === 'cochange' ? '↔' : '→'} <strong>${esc(mode === 'modules' ? d.c : base(d.c))}</strong><br>${d.v} ${unit}`, ev))
      .on('mousemove', tipMove).on('mouseout', tipHide);
  }
  wireModes(panel, build);
  build('modules');
}

// ═══ 5. SANKEY ═══════════════════════════════════════════════════════════════
function initSankey() {
  const panel = document.getElementById('sankey');
  if (!d3.sankey) { panel.innerHTML = '<div class="empty">d3-sankey failed to load (offline?) — refresh with network access.</div>'; return; }
  panel.innerHTML = `<div class="graph-controls">
      ${modeBar('sankey', [{k:'code',label:'Codebase flow'},{k:'agent',label:'Agent activity'}], 'agent')}
      <span class="hint" id="sankey-hint"></span>
    </div><svg id="sankey-svg" class="viz-svg"></svg>`;
  const svg = d3.select('#sankey-svg');
  const [w, h] = svgSize(svg);

  function build(mode) {
    svg.selectAll('*').remove();
    const nodes = new Map(), links = [];
    const N = (id, label, color, tipHtml) => {
      if (!nodes.has(id)) nodes.set(id, { id, label, color, tipHtml });
      return id;
    };
    const L = (s, t, v) => { if (v > 0) links.push({ source: s, target: t, value: v }); };

    if (mode === 'code') {
      document.getElementById('sankey-hint').textContent = 'band width = lines of code: top-level dir → module → biggest files';
      const byMod = new Map();
      FILES.forEach(f => {
        const loc = (M[f] || {}).loc || 1, grp = groupOf(f), top = f.includes('/') ? f.split('/')[0] : '(root)';
        if (!byMod.has(grp)) byMod.set(grp, { top, files: [], loc: 0 });
        const e = byMod.get(grp); e.files.push(f); e.loc += loc;
      });
      const topFiles = new Set(FILES.slice().sort((a, b) => ((M[b] || {}).loc || 0) - ((M[a] || {}).loc || 0)).slice(0, 26));
      byMod.forEach((e, grp) => {
        const c = GC[grp] || '#8b949e';
        N('d:' + e.top, e.top, GC[e.top] || c);
        N('m:' + grp, grp, c);
        L('d:' + e.top, 'm:' + grp, e.loc);
        let rest = 0;
        e.files.forEach(f => {
          const loc = (M[f] || {}).loc || 1;
          if (topFiles.has(f)) { N('f:' + f, base(f), c, fileTip(f)); L('m:' + grp, 'f:' + f, loc); }
          else rest += loc;
        });
        if (rest > 0 && e.files.length > 1) { N('r:' + grp, '(' + e.files.length + ' files…)', '#484f58'); L('m:' + grp, 'r:' + grp, rest); }
      });
    } else {
      document.getElementById('sankey-hint').textContent = 'sessions → tools → what they hit: modules, shell commands, sub-agents, questions to you';
      const sess = (AG.sessions || []).map(s => ({ ...s, total: Object.values(s.tools || {}).reduce((a, b) => a + b, 0) + (s.questions || []).length }))
        .filter(s => s.total > 0).sort((a, b) => b.total - a.total);
      const topSess = sess.slice(0, 12), rest = sess.slice(12);
      const toolSum = {};
      sess.forEach(s => { Object.entries(s.tools || {}).forEach(([t, c]) => toolSum[t] = (toolSum[t] || 0) + c); });
      const qTotal = sess.reduce((a, s) => a + (s.questions || []).length, 0);
      const topTools = Object.keys(toolSum).sort((a, b) => toolSum[b] - toolSum[a]).slice(0, 11);
      const toolNode = t => topTools.includes(t) ? 't:' + t : 't:(other tools)';
      const toolColor = {}; topTools.forEach((t, i) => toolColor['t:' + t] = PAL[i % PAL.length]);

      const addSess = (s, id, label) => {
        N(id, label, '#8b949e', `<strong>${esc(s.title || label)}</strong><br>${s.total} agent actions`);
        const perTool = {};
        Object.entries(s.tools || {}).forEach(([t, c]) => perTool[toolNode(t)] = (perTool[toolNode(t)] || 0) + c);
        Object.entries(perTool).forEach(([tn, c]) => { N(tn, tn.slice(2), toolColor[tn] || '#8b949e'); L(id, tn, c); });
        if ((s.questions || []).length) { N('t:ask user', 'ask user', '#bc8cff'); L(id, 't:ask user', s.questions.length); }
      };
      topSess.forEach((s, i) => addSess(s, 's:' + i, (s.title || '').slice(0, 32)));
      if (rest.length) {
        const agg = { title: rest.length + ' more sessions', tools: {}, questions: [], total: 0 };
        rest.forEach(s => { Object.entries(s.tools || {}).forEach(([t, c]) => agg.tools[t] = (agg.tools[t] || 0) + c); agg.questions.push(...(s.questions || [])); agg.total += s.total; });
        addSess(agg, 's:rest', '(' + rest.length + ' more sessions)');
      }

      // tools → outcomes
      const modReads = {}, modWrites = {};
      Object.entries(AG.fileTouches || {}).forEach(([f, t]) => {
        const g_ = groupOf(f);
        modReads[g_] = (modReads[g_] || 0) + (t.reads || 0);
        modWrites[g_] = (modWrites[g_] || 0) + (t.writes || 0);
      });
      const outMod = g_ => N('o:' + g_, g_, GC[g_] || '#8b949e');
      Object.entries(modReads).forEach(([g_, c]) => { if (toolSum['read_file']) L(toolNode('read_file'), outMod(g_), c); });
      Object.entries(modWrites).forEach(([g_, c]) => { if (toolSum['edit_file'] || toolSum['write_file']) L(toolNode('edit_file'), outMod(g_), c); });
      const cmds = AG.topCommands || [];
      const shellTotal = toolSum['run_shell'] || 0;
      let cmdShown = 0;
      cmds.slice(0, 8).forEach(c => {
        const sample = (AG.commands || []).filter(x => x.cmd.startsWith(c.bin)).slice(0, 4).map(x => '· ' + esc(x.cmd.slice(0, 70))).join('<br>');
        N('o:$' + c.bin, '$ ' + c.bin, '#d29922', `<strong>$ ${esc(c.bin)}</strong> — ${c.count} runs<br>${sample}`);
        L(toolNode('run_shell'), 'o:$' + c.bin, c.count); cmdShown += c.count;
      });
      if (shellTotal - cmdShown > 0) { N('o:$…', '$ (other cmds)', '#484f58'); L(toolNode('run_shell'), 'o:$…', shellTotal - cmdShown); }
      if (toolSum['spawn_task']) {
        const sample = (AG.spawns || []).slice(0, 5).map(x => '· ' + esc(x.task.replace(/^\{"task":\s*"/, '').slice(0, 70))).join('<br>');
        N('o:spawn', 'sub-agent tasks', '#ff7b72', `<strong>sub-agents spawned</strong><br>${sample}`);
        L(toolNode('spawn_task'), 'o:spawn', toolSum['spawn_task']);
      }
      if (qTotal) {
        const sample = (AG.questions || []).slice(-6).map(x => '· ' + esc(x.q.slice(0, 75))).join('<br>');
        N('o:q', 'questions to you', '#bc8cff', `<strong>Aura asked you</strong> (${qTotal})<br>${sample}`);
        L('t:ask user', 'o:q', qTotal);
      }
      const webT = ['web_fetch', 'web_search', 'browser', 'http_request'].reduce((a, t) => a + (toolSum[t] || 0), 0);
      if (webT) { N('o:web', 'web / http', '#39c5cf'); ['web_fetch', 'web_search', 'browser', 'http_request'].forEach(t => { if (toolSum[t]) L(toolNode(t), 'o:web', toolSum[t]); }); }
      ['run_tests', 'search_code', 'git_status', 'git_diff', 'memory', 'email', 'mcp', 'audio_transcribe', 'list_dir', 'image_read', 'write_file'].forEach(t => {
        if (!toolSum[t]) return;
        const target = t === 'run_tests' ? ['o:tests', 'test runs', '#3fb950']
          : t === 'search_code' ? ['o:search', 'code search', '#79c0ff']
          : t.startsWith('git') ? ['o:git', 'git', '#f0883e']
          : t === 'memory' ? ['o:mem', 'memory store', '#d2a8ff']
          : ['o:misc', '(misc)', '#484f58'];
        if (t === 'write_file' || t === 'list_dir' || t === 'image_read') return; // already flow to modules via edit/read
        N(target[0], target[1], target[2]); L(toolNode(t), target[0], toolSum[t]);
      });
    }

    const nodeArr = [...nodes.values()].map(n => ({ ...n }));
    const linkAgg = new Map();
    links.forEach(l => { const k = l.source + '\t' + l.target; linkAgg.set(k, (linkAgg.get(k) || 0) + l.value); });
    const linkArr = [...linkAgg.entries()].map(([k, value]) => { const [source, target] = k.split('\t'); return { source, target, value }; });

    const sk = d3.sankey().nodeId(d => d.id).nodeWidth(12).nodePadding(7)
      .nodeAlign(d3.sankeyJustify).extent([[10, 12], [w - 10, h - 12]]);
    let graph;
    try { graph = sk({ nodes: nodeArr, links: linkArr }); }
    catch (err) { svg.append('text').attr('x', 20).attr('y', 30).attr('fill', 'var(--error)').text('sankey error: ' + err.message); return; }

    svg.append('g').selectAll('path').data(graph.links).join('path')
      .attr('d', d3.sankeyLinkHorizontal())
      .attr('fill', 'none')
      .attr('stroke', d => d.source.color || '#484f58')
      .attr('stroke-width', d => Math.max(1, d.width))
      .attr('opacity', 0.32)
      .on('mouseover', function (ev, d) {
        d3.select(this).attr('opacity', 0.7);
        tipShow(`<strong>${esc(d.source.label)}</strong> → <strong>${esc(d.target.label)}</strong><br>${d.value.toLocaleString()}`, ev);
      })
      .on('mousemove', tipMove)
      .on('mouseout', function () { d3.select(this).attr('opacity', 0.32); tipHide(); });

    const nodeSel = svg.append('g').selectAll('g').data(graph.nodes).join('g');
    nodeSel.append('rect')
      .attr('x', d => d.x0).attr('y', d => d.y0)
      .attr('width', d => d.x1 - d.x0).attr('height', d => Math.max(1, d.y1 - d.y0))
      .attr('rx', 2).attr('fill', d => d.color || '#8b949e')
      .on('mouseover', (ev, d) => tipShow(d.tipHtml || `<strong>${esc(d.label)}</strong><br>${(d.value || 0).toLocaleString()}`, ev))
      .on('mousemove', tipMove).on('mouseout', tipHide);
    nodeSel.append('text')
      .attr('x', d => d.x0 < w / 2 ? d.x1 + 5 : d.x0 - 5)
      .attr('y', d => (d.y0 + d.y1) / 2)
      .attr('text-anchor', d => d.x0 < w / 2 ? 'start' : 'end')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', 9.5).attr('fill', 'var(--text)')
      .text(d => (d.y1 - d.y0) > 3.5 ? d.label : '');
  }
  wireModes(panel, build);
  build('agent');
}

// ═══ 6. RADIAL TREE ══════════════════════════════════════════════════════════
function initRadial() {
  const panel = document.getElementById('radial');
  panel.innerHTML = `<div class="graph-controls">
      ${legendHtml(GROUPS.filter(g => g.startsWith('src/')).slice(0, 10))}
      <span class="hint">the whole repo fanned into a circle · dot size = LOC · red ring = high churn · scroll to zoom</span>
    </div><svg id="radial-svg" class="viz-svg"></svg>`;
  const svg = d3.select('#radial-svg');
  const [w, h] = svgSize(svg);
  const R = Math.min(w, h) / 2 - 90;

  const ROOT = '~';
  const ids = new Set();
  FILES.forEach(f => {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) ids.add(parts.slice(0, i).join('/'));
  });
  const rows = [{ id: ROOT, parent: null }];
  ids.forEach(d => rows.push({ id: d, parent: d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : ROOT }));
  FILES.forEach(f => { if (!ids.has(f)) rows.push({ id: f, parent: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ROOT }); });

  const root = d3.stratify().id(d => d.id).parentId(d => d.parent)(rows);
  root.count();
  d3.cluster().size([2 * Math.PI, R])(root);

  const g = svg.append('g').attr('transform', `translate(${w / 2},${h / 2})`);
  svg.call(d3.zoom().scaleExtent([0.5, 8]).on('zoom', ev =>
    g.attr('transform', `translate(${w / 2},${h / 2}) scale(${ev.transform.k}) translate(${ev.transform.x / ev.transform.k},${ev.transform.y / ev.transform.k})`)));

  const branchColor = d => {
    const p = (d.data.id || '').split('/');
    const key = p[0] === 'src' && p.length >= 2 ? 'src/' + p[1] : p[0];
    return GC[key] || '#8b949e';
  };
  g.append('g').selectAll('path').data(root.links()).join('path')
    .attr('d', d3.linkRadial().angle(d => d.x).radius(d => d.y))
    .attr('fill', 'none')
    .attr('stroke', d => branchColor(d.target))
    .attr('stroke-width', d => d.target.children ? 1.4 : 0.7)
    .attr('opacity', d => d.target.children ? 0.75 : 0.45);

  const leafSel = g.append('g').selectAll('circle').data(root.descendants().filter(d => d.depth > 0)).join('circle')
    .attr('transform', d => `rotate(${d.x * 180 / Math.PI - 90}) translate(${d.y},0)`)
    .attr('r', d => d.children ? 2.5 : 1.6 + Math.min(4.5, Math.sqrt((M[d.data.id] || {}).loc || 8) / 6))
    .attr('fill', d => d.children ? '#484f58' : branchColor(d))
    .attr('stroke', d => (!d.children && ((M[d.data.id] || {}).churn || 0) >= 3) ? '#f85149' : 'none')
    .attr('stroke-width', 1.6);
  leafSel.on('mouseover', (ev, d) => tipShow(d.children
      ? `<strong>${esc(d.data.id)}/</strong><br>${d.value} files`
      : fileTip(d.data.id), ev))
    .on('mousemove', tipMove).on('mouseout', tipHide);

  g.append('circle').attr('r', 6).attr('fill', 'var(--primary)');
  g.append('g').selectAll('text').data(root.descendants().filter(d => d.children && d.depth >= 1 && d.depth <= 2 && d.value >= 3)).join('text')
    .attr('transform', d => {
      const deg_ = d.x * 180 / Math.PI - 90, flip = d.x > Math.PI;
      return `rotate(${deg_}) translate(${d.y + 8},0)` + (flip ? ' rotate(180)' : '');
    })
    .attr('text-anchor', d => d.x > Math.PI ? 'end' : 'start')
    .attr('dominant-baseline', 'middle')
    .attr('font-size', 9).attr('font-weight', 600)
    .attr('fill', d => branchColor(d))
    .text(d => base(d.data.id));
}

// ═══ 7. PARTICLE-FLOW NETWORK ════════════════════════════════════════════════
let particlesRAF = null;
function initParticles() {
  const panel = document.getElementById('particles');
  panel.innerHTML = `<div class="graph-controls">
      ${legendHtml(GROUPS.slice(0, 10))}
      <span class="hint">particles flow along import direction · speed &amp; count = import weight · drag nodes, scroll to zoom</span>
    </div><svg id="particles-svg" class="viz-svg"></svg>`;
  const svg = d3.select('#particles-svg');
  const [w, h] = svgSize(svg);

  const deg = {};
  FF.forEach(e => { deg[e.source] = (deg[e.source] || 0) + e.w; deg[e.target] = (deg[e.target] || 0) + e.w; });
  const nodes = FILES.filter(f => deg[f]).map(f => ({ id: f, grp: groupOf(f) }));
  const links = FF.map(e => ({ source: e.source, target: e.target, w: e.w }));
  const rOf = d => 3 + Math.min(6, Math.sqrt(deg[d.id] || 1) * 1.1);

  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.3, 6]).on('zoom', ev => g.attr('transform', ev.transform)));

  const defs = svg.append('defs');
  const grad = defs.append('radialGradient').attr('id', 'pglow');
  grad.append('stop').attr('offset', '0%').attr('stop-color', '#f0883e').attr('stop-opacity', 0.6);
  grad.append('stop').attr('offset', '100%').attr('stop-color', '#f0883e').attr('stop-opacity', 0);

  const linkSel = g.append('g').selectAll('line').data(links).join('line')
    .attr('stroke', '#484f58').attr('stroke-width', d => 0.5 + Math.sqrt(d.w) * 0.5).attr('opacity', 0.3);

  const topLinks = links.slice().sort((a, b) => b.w - a.w).slice(0, 150);
  const parts = [];
  topLinks.forEach(l => {
    const k = Math.min(3, l.w);
    for (let i = 0; i < k; i++) parts.push({ l, t: Math.random(), sp: 0.0025 + 0.0015 * Math.min(4, l.w) * Math.random() });
  });
  const haloSel = g.append('g').selectAll('circle').data(parts).join('circle')
    .attr('r', 4.5).attr('fill', 'url(#pglow)');
  const dotSel = g.append('g').selectAll('circle').data(parts).join('circle')
    .attr('r', 1.7).attr('fill', '#ffd9b0');

  const nodeSel = g.append('g').selectAll('circle').data(nodes).join('circle')
    .attr('r', rOf).attr('fill', d => GC[d.grp] || '#8b949e')
    .attr('stroke', '#1c2128').attr('stroke-width', 1.2)
    .call(d3.drag()
      .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end', (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
  nodeSel.on('mouseover', (ev, d) => tipShow(fileTip(d.id), ev)).on('mousemove', tipMove).on('mouseout', tipHide);

  const labelSel = g.append('g').selectAll('text')
    .data(nodes.filter(d => deg[d.id] >= 8)).join('text')
    .text(d => base(d.id)).attr('font-size', 9).attr('fill', 'var(--muted)').attr('dy', -10).attr('text-anchor', 'middle');

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(46).strength(l => Math.min(1, 0.15 + l.w * 0.08)))
    .force('charge', d3.forceManyBody().strength(-90))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collide', d3.forceCollide(d => rOf(d) + 3));
  sim.on('tick', () => {
    linkSel.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    nodeSel.attr('cx', d => d.x).attr('cy', d => d.y);
    labelSel.attr('x', d => d.x).attr('y', d => d.y);
  });

  function frame() {
    if (!panel.classList.contains('active')) { particlesRAF = null; return; }
    parts.forEach(p => { p.t += p.sp; if (p.t > 1) p.t = 0; });
    haloSel.attr('cx', p => p.l.source.x + (p.l.target.x - p.l.source.x) * p.t)
           .attr('cy', p => p.l.source.y + (p.l.target.y - p.l.source.y) * p.t);
    dotSel.attr('cx', p => p.l.source.x + (p.l.target.x - p.l.source.x) * p.t)
          .attr('cy', p => p.l.source.y + (p.l.target.y - p.l.source.y) * p.t);
    particlesRAF = requestAnimationFrame(frame);
  }
  panel._resume = () => { if (!particlesRAF) particlesRAF = requestAnimationFrame(frame); };
  panel._resume();
}

// ═══ 8. FORCE CLUSTERS WITH HULLS ════════════════════════════════════════════
function initHulls() {
  const panel = document.getElementById('hulls');
  panel.innerHTML = `<div class="graph-controls">
      ${legendHtml(GROUPS.slice(0, 12))}
      <span class="hint">each hull = one module’s territory · dashed lines = cross-module coupling · drag nodes, scroll to zoom</span>
    </div><svg id="hulls-svg" class="viz-svg"></svg>`;
  const svg = d3.select('#hulls-svg');
  const [w, h] = svgSize(svg);

  const deg = {};
  FF.forEach(e => { deg[e.source] = (deg[e.source] || 0) + e.w; deg[e.target] = (deg[e.target] || 0) + e.w; });
  const nodes = FILES.filter(f => deg[f]).map(f => ({ id: f, grp: groupOf(f) }));
  const links = FF.map(e => ({ source: e.source, target: e.target, w: e.w, inter: groupOf(e.source) !== groupOf(e.target) }));
  const grpsHere = [...new Set(nodes.map(n => n.grp))].sort((a, b) => gIdx[a] - gIdx[b]);
  const center = {};
  grpsHere.forEach((g_, i) => {
    const a = -Math.PI / 2 + (i / grpsHere.length) * 2 * Math.PI;
    center[g_] = polar(w / 2, h / 2, Math.min(w, h) * 0.30, a);
  });

  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.3, 6]).on('zoom', ev => g.attr('transform', ev.transform)));

  const hullG = g.append('g');
  const hullLine = d3.line().curve(d3.curveCatmullRomClosed);
  const linkSel = g.append('g').selectAll('line').data(links).join('line')
    .attr('stroke', l => l.inter ? '#8b949e' : (GC[groupOf(typeof l.source === 'string' ? l.source : l.source.id)] || '#8b949e'))
    .attr('stroke-dasharray', l => l.inter ? '5,4' : null)
    .attr('stroke-width', l => 0.5 + Math.sqrt(l.w) * 0.5)
    .attr('opacity', l => l.inter ? 0.55 : 0.3);
  const rOf = d => 3 + Math.min(5, Math.sqrt(deg[d.id] || 1));
  const nodeSel = g.append('g').selectAll('circle').data(nodes).join('circle')
    .attr('r', rOf).attr('fill', d => GC[d.grp] || '#8b949e')
    .attr('stroke', '#1c2128').attr('stroke-width', 1.2)
    .call(d3.drag()
      .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end', (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
  nodeSel.on('mouseover', (ev, d) => tipShow(fileTip(d.id), ev)).on('mousemove', tipMove).on('mouseout', tipHide);
  const labG = g.append('g');

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(38).strength(0.05))
    .force('charge', d3.forceManyBody().strength(-42))
    .force('x', d3.forceX(d => center[d.grp][0]).strength(0.3))
    .force('y', d3.forceY(d => center[d.grp][1]).strength(0.3))
    .force('collide', d3.forceCollide(d => rOf(d) + 2.5));

  sim.on('tick', () => {
    linkSel.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    nodeSel.attr('cx', d => d.x).attr('cy', d => d.y);

    const hulls = [], labels = [];
    grpsHere.forEach(g_ => {
      const pts = nodes.filter(n => n.grp === g_).map(n => [n.x, n.y]);
      if (pts.length < 2) return;
      const cx_ = d3.mean(pts, p => p[0]), cy_ = d3.mean(pts, p => p[1]);
      labels.push({ g: g_, x: cx_, y: cy_ - (d3.max(pts, p => Math.abs(p[1] - cy_)) || 20) - 14 });
      let hull = pts.length >= 3 ? d3.polygonHull(pts) : pts;
      if (!hull) return;
      hulls.push({ g: g_, d: hullLine(hull.map(p => [cx_ + (p[0] - cx_) * 1.28, cy_ + (p[1] - cy_) * 1.28])) });
    });
    hullG.selectAll('path').data(hulls, d => d.g).join('path')
      .attr('d', d => d.d)
      .attr('fill', d => GC[d.g] || '#8b949e').attr('fill-opacity', 0.09)
      .attr('stroke', d => GC[d.g] || '#8b949e').attr('stroke-opacity', 0.45).attr('stroke-width', 1.3);
    labG.selectAll('text').data(labels, d => d.g).join('text')
      .attr('x', d => d.x).attr('y', d => d.y)
      .attr('text-anchor', 'middle').attr('font-size', 10).attr('font-weight', 700)
      .attr('letter-spacing', '0.08em')
      .attr('fill', d => GC[d.g] || '#8b949e').attr('opacity', 0.85)
      .text(d => d.g.toUpperCase());
  });
}

// ═══ registry ════════════════════════════════════════════════════════════════
const PANELS = { bundling: initBundling, chord: initChord, arc: initArc, matrix: initMatrix, sankey: initSankey, radial: initRadial, particles: initParticles, hulls: initHulls };
const inited = {};
window.AURA_X = {
  open(id) {
    const f = PANELS[id];
    if (!f) return;
    if (!inited[id]) {
      inited[id] = true;
      try { f(); } catch (err) {
        console.error(err);
        document.getElementById(id).innerHTML = '<div class="empty">panel error: ' + esc(err.message) + '</div>';
      }
    }
    const p = document.getElementById(id);
    if (p && p._resume) p._resume();
  }
};

// deep-link: dashboard.html#chord opens that tab
if (location.hash) {
  const id = location.hash.slice(1);
  const btn = [...document.querySelectorAll('nav button')].find(b => (b.getAttribute('onclick') || '').includes("'" + id + "'"));
  if (btn) showPanel(id, btn);
}
})();
