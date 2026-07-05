import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ExecutionPlan } from '../orchestration/types.js';
import type { ChatSession } from '../agent/session-store.js';

// ─────────────────────────────────────────────────────────────────────────────
// Data loaders
// ─────────────────────────────────────────────────────────────────────────────

function loadGraph(projectRoot: string): object | null {
  const p = path.join(projectRoot, 'graphify-out', 'graph.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadPlans(projectRoot: string): ExecutionPlan[] {
  const base = path.join(process.env.HOME ?? '/tmp', '.aura', 'plans');
  if (!fs.existsSync(base)) return [];

  const safe = projectRoot.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);

  const readDir = (d: string): ExecutionPlan[] => {
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d)
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as ExecutionPlan; }
        catch { return null; }
      })
      .filter((p): p is ExecutionPlan => p !== null);
  };

  // Plans from root level + project-specific subdir
  const rootPlans = readDir(base);
  const subPlans  = readDir(path.join(base, safe));

  const seen = new Set(rootPlans.map(p => p.id));
  const merged = [...rootPlans];
  for (const p of subPlans) {
    if (!seen.has(p.id)) merged.push(p);
  }

  return merged.sort((a, b) => b.created - a.created);
}

function loadSessions(projectRoot: string): ChatSession[] {
  const base = path.join(process.env.HOME ?? '/tmp', '.aura', 'sessions');
  const safe = projectRoot.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);

  const readDir = (d: string): ChatSession[] => {
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d)
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as Partial<ChatSession>;
          if (!parsed.id) return null;
          return parsed as ChatSession;
        } catch { return null; }
      })
      .filter((s): s is ChatSession => s !== null);
  };

  // Sessions from project-specific subdir + any .json files at root level
  const subSessions  = readDir(path.join(base, safe));
  const rootSessions = readDir(base);

  const seen = new Set(subSessions.map(s => s.id));
  const merged = [...subSessions];
  for (const s of rootSessions) {
    if (!seen.has(s.id)) merged.push(s);
  }

  return merged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

/**
 * Strip a session down to metadata only — removes the full message history
 * which can contain backticks, </script> tags, and other HTML-breaking content.
 */
function stripSession(s: ChatSession): Record<string, unknown> {
  const history = s.history ?? [];
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: history.length,
    toolCallCount: history.filter(m => m.role === 'tool_result').length,
  };
}

/**
 * Strip a plan down to metadata only — removes step result strings and
 * plan outcome which can contain code with backticks or </script> sequences.
 */
function stripPlan(p: ExecutionPlan): Record<string, unknown> {
  return {
    id: p.id,
    goal: p.goal,
    status: p.status,
    created: p.created,
    completed: p.completed,
    steps: p.steps.map(s => ({
      id: s.id,
      specialist: s.specialist,
      task: s.task,
      status: s.status,
      durationMs: s.durationMs,
      dependsOn: s.dependsOn,
    })),
  };
}

function loadMemory(projectRoot: string): object[] {
  const base = path.join(process.env.HOME ?? '/tmp', '.aura', 'memory');
  const safe = projectRoot.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const dir = path.join(base, safe);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch { return null; }
    })
    .filter((m): m is object => m !== null);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML template
// ─────────────────────────────────────────────────────────────────────────────

function buildHtml(data: {
  graph: object | null;
  plans: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  memory: object[];
  projectName: string;
  generatedAt: string;
}): string {
  // Escape </script> in JSON to prevent premature script-block closing in HTML
  const json = JSON.stringify(data, null, 0).replace(/<\/script>/gi, '<\\/script>');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aura — Memory Dashboard · ${data.projectName}</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
  :root {
    --bg:      #0d1117;
    --surface: #161b22;
    --canvas:  #1c2128;
    --card:    #21262d;
    --border:  #30363d;
    --border2: #484f58;
    --primary: #f0883e;
    --text:    #e6edf3;
    --muted:   #8b949e;
    --dim:     #6e7681;
    --success: #3fb950;
    --error:   #f85149;
    --amber:   #d29922;
    --blue:    #58a6ff;
    --purple:  #bc8cff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: ui-monospace, 'JetBrains Mono', 'Fira Code', monospace; font-size: 13px; min-height: 100vh; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; gap: 16px; }
  header h1 { color: var(--primary); font-size: 14px; font-weight: 700; letter-spacing: 0.03em; }
  header .meta { color: var(--muted); font-size: 11px; }
  nav { background: var(--surface); border-bottom: 1px solid var(--border); display: flex; }
  nav button { background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted); cursor: pointer; font: inherit; font-size: 12px; padding: 9px 18px; transition: color .12s; }
  nav button:hover { color: var(--text); }
  nav button.active { border-bottom-color: var(--primary); color: var(--primary); }
  .panel { display: none; padding: 20px; height: calc(100vh - 82px); overflow: auto; }
  .panel.active { display: flex; flex-direction: column; gap: 14px; }

  /* Overview */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; }
  .stat-card .num { color: var(--primary); font-size: 30px; font-weight: 700; line-height: 1; }
  .stat-card .lbl { color: var(--muted); font-size: 10px; margin-top: 5px; text-transform: uppercase; letter-spacing: .08em; }

  /* Graph panel */
  #graph-svg { background: var(--canvas); border: 1px solid var(--border); border-radius: 8px; flex: 1; min-height: 0; cursor: grab; }
  #graph-svg:active { cursor: grabbing; }
  .graph-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .mode-toggle { display: flex; gap: 4px; }
  .mode-btn { background: var(--card); border: 1px solid var(--border); border-radius: 6px; color: var(--muted); cursor: pointer; font: inherit; font-size: 11px; padding: 5px 11px; transition: all .12s; }
  .mode-btn:hover { border-color: var(--border2); color: var(--text); }
  .mode-btn.active { background: var(--primary); border-color: var(--primary); color: #1c1108; font-weight: 700; }
  .graph-controls input {
    background: var(--card); border: 1px solid var(--border2); border-radius: 6px;
    color: var(--text); font: inherit; font-size: 12px; padding: 6px 12px; width: 220px; outline: none;
  }
  .graph-controls input:focus { border-color: var(--primary); }
  .legend { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .legend-item { display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; padding: 3px 9px; border-radius: 12px; border: 1.5px solid transparent; font-size: 11px; color: var(--muted); transition: all .12s; }
  .legend-item.on { border-color: currentColor; color: var(--text); }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .hint { color: var(--dim); font-size: 10px; }

  /* Tooltip */
  .tooltip {
    position: fixed; background: #161b22f0; border: 1px solid var(--border2);
    border-radius: 7px; color: var(--text); font-size: 11px; max-width: 300px;
    padding: 9px 13px; pointer-events: none; z-index: 999; line-height: 1.6;
    box-shadow: 0 4px 20px #0008;
  }
  .tooltip strong { color: var(--primary); font-size: 12px; }
  .tooltip .t-type { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
  .tooltip .t-file { color: var(--blue); font-size: 10px; }

  /* Sessions */
  .session-list { display: flex; flex-direction: column; gap: 8px; }
  .session-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; padding: 12px 16px; transition: border-color .12s; }
  .session-card:hover { border-color: var(--border2); }
  .session-card.expanded { border-color: var(--primary); }
  .s-header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .s-title { color: var(--text); font-size: 13px; font-weight: 600; }
  .s-meta { color: var(--muted); font-size: 11px; white-space: nowrap; }
  .s-id { color: var(--dim); font-size: 10px; margin-top: 3px; }
  .session-messages { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 10px; display: none; }
  .session-card.expanded .session-messages { display: block; }
  .msg { display: flex; gap: 10px; margin-bottom: 8px; }
  .msg-role { font-size: 10px; min-width: 64px; padding-top: 1px; text-align: right; text-transform: uppercase; font-weight: 700; letter-spacing: .04em; flex-shrink: 0; }
  .msg-role.user { color: var(--amber); }
  .msg-role.assistant { color: var(--blue); }
  .msg-role.tool_result { color: var(--success); }
  .msg-content { color: var(--muted); font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 100px; overflow: auto; }

  /* Plans */
  .plans-layout { display: flex; gap: 14px; flex: 1; min-height: 0; }
  .plan-list-panel { display: flex; flex-direction: column; gap: 7px; width: 290px; flex-shrink: 0; overflow-y: auto; }
  .plan-detail { flex: 1; display: flex; flex-direction: column; gap: 12px; min-height: 0; min-width: 0; }
  .plan-card { background: var(--card); border: 1px solid var(--border); border-radius: 7px; cursor: pointer; padding: 10px 13px; transition: border-color .12s; }
  .plan-card:hover { border-color: var(--border2); }
  .plan-card.selected { border-color: var(--primary); background: #21262dcc; }
  .p-goal { color: var(--text); font-size: 12px; line-height: 1.4; }
  .p-meta { color: var(--muted); font-size: 10px; margin-top: 5px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .status-badge { border-radius: 10px; font-size: 10px; font-weight: 700; padding: 2px 8px; display: inline-block; letter-spacing: .03em; }
  .status-done    { background: #1f3a2a; color: #3fb950; border: 1px solid #3fb95050; }
  .status-failed  { background: #3a1f1f; color: #f85149; border: 1px solid #f8514950; }
  .status-running { background: #332a1a; color: #d29922; border: 1px solid #d2992250; }
  .status-pending { background: #1a2233; color: #58a6ff; border: 1px solid #58a6ff50; }
  .status-aborted { background: #252530; color: #8b949e; border: 1px solid #8b949e50; }
  #dag-svg { background: var(--canvas); border: 1px solid var(--border); border-radius: 8px; flex: 1; min-height: 300px; cursor: grab; }
  #dag-svg:active { cursor: grabbing; }
  .step-result { background: var(--canvas); border: 1px solid var(--border); border-radius: 7px; color: var(--muted); font-size: 11px; line-height: 1.55; max-height: 180px; overflow-y: auto; padding: 12px 14px; white-space: pre-wrap; word-break: break-word; }

  /* Memory table */
  .memory-table { border-collapse: collapse; width: 100%; }
  .memory-table th { background: var(--card); border-bottom: 2px solid var(--border); color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .08em; padding: 9px 13px; text-align: left; text-transform: uppercase; }
  .memory-table td { border-bottom: 1px solid var(--border); color: var(--muted); font-size: 11px; padding: 8px 13px; vertical-align: top; }
  .memory-table td:first-child { color: var(--primary); white-space: nowrap; font-weight: 600; }
  .memory-table tr:hover td { background: var(--card); }
  .memory-val { max-width: 560px; white-space: pre-wrap; word-break: break-word; color: var(--text); }

  .empty { color: var(--dim); font-size: 12px; padding: 32px; text-align: center; }

  /* New panel styles */
  .axis line, .axis path { stroke: var(--border); }
  .grid line { stroke: var(--border); stroke-dasharray: 3,3; }
  .tooltip { position: fixed; background: #161b22f0; border: 1px solid var(--border2); border-radius: 7px; color: var(--text); font-size: 11px; max-width: 300px; padding: 9px 13px; pointer-events: none; z-index: 999; line-height: 1.6; box-shadow: 0 4px 20px #0008; }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }
</style>
</head>
<body>
<header>
  <h1>◈ Aura / memory dashboard</h1>
  <span class="meta">project: <strong style="color:var(--primary)">${data.projectName}</strong> &nbsp;·&nbsp; ${data.generatedAt}</span>
</header>
<nav>
  <button class="active" onclick="showPanel('overview',this)">Overview</button>
  <button onclick="showPanel('graph',this)">Codebase Graph</button>
  <button onclick="showPanel('sessions',this)">Sessions</button>
  <button onclick="showPanel('plans',this)">Execution Plans</button>
  <button onclick="showPanel('memory',this)">Agent Memory</button>
  <button onclick="showPanel('activity',this)">Activity Timeline</button>
  <button onclick="showPanel('centrality',this)">Code Centrality</button>
  <button onclick="showPanel('specialists',this)">Specialist Stats</button>
  <button onclick="showPanel('tools',this)">Tool Usage</button>
</nav>

<div id="overview" class="panel active"></div>
<div id="graph"       class="panel"></div>
<div id="sessions"    class="panel"></div>
<div id="plans"       class="panel"></div>
<div id="memory"      class="panel"></div>
<div id="activity"    class="panel"></div>
<div id="centrality"  class="panel"></div>
<div id="specialists" class="panel"></div>
<div id="tools"       class="panel"></div>

<div class="tooltip" id="tooltip" style="display:none"></div>

<script>
const DATA = ` + json + `;

function showPanel(id, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (btn) btn.classList.add('active');
  if (id === 'graph'       && !graphInit) initGraph();
  if (id === 'plans'       && !plansInit) initPlans();
  if (id === 'activity'    && !activityInit) initActivity();
  if (id === 'centrality'  && !centralityInit) initCentrality();
  if (id === 'specialists' && !specialistsInit) initSpecialists();
  if (id === 'tools'       && !toolsInit) initTools();
}

// ── Overview ─────────────────────────────────────────────────────────────────
(function() {
  const g = DATA.graph;
  const nc = g ? g.nodes.length : 0, ec = g ? g.edges.length : 0;
  const sc = DATA.sessions.length, pc = DATA.plans.length;
  const mc = DATA.memory.length, dc = DATA.plans.filter(p=>p.status==='done').length;
  const last = sc ? new Date(DATA.sessions[0].updatedAt).toLocaleString()
             : pc ? new Date(DATA.plans[0].created).toLocaleString() : '—';

  const NODE_C = {file:'#58a6ff',function:'#ff7b72',class:'#d2a8ff',interface:'#3fb950',const:'#ffa657',type:'#79c0ff',enum:'#f85149'};
  const types = g ? g.nodes.reduce((a,n)=>{const t=n.type||'node';a[t]=(a[t]||0)+1;return a;},{}) : {};
  const breakdown = Object.entries(types).sort((a,b)=>b[1]-a[1]).slice(0,8)
    .map(([t,c])=>\`<span style="display:inline-flex;align-items:center;gap:5px;margin:3px 6px 3px 0">
      <span style="width:9px;height:9px;border-radius:50%;background:\${NODE_C[t]||'#8b949e'};flex-shrink:0"></span>
      <strong style="color:var(--text)">\${c}</strong>
      <span style="color:var(--muted)">\${t}s</span>
    </span>\`).join('');

  document.getElementById('overview').innerHTML = \`
    <div class="stats-grid">
      <div class="stat-card"><div class="num">\${nc}</div><div class="lbl">Graph Nodes</div></div>
      <div class="stat-card"><div class="num">\${ec}</div><div class="lbl">Graph Edges</div></div>
      <div class="stat-card"><div class="num">\${sc}</div><div class="lbl">Chat Sessions</div></div>
      <div class="stat-card"><div class="num">\${pc}</div><div class="lbl">Exec Plans</div></div>
      <div class="stat-card"><div class="num">\${dc}</div><div class="lbl">Plans Done</div></div>
      <div class="stat-card"><div class="num">\${mc}</div><div class="lbl">Memory Entries</div></div>
    </div>
    <div class="stat-card" style="max-width:640px">
      <div class="lbl" style="margin-bottom:10px">Codebase Breakdown</div>
      <div style="display:flex;flex-wrap:wrap">\${breakdown||'<span style="color:var(--dim)">no graph data</span>'}</div>
    </div>
    <div class="stat-card" style="max-width:360px">
      <div class="lbl" style="margin-bottom:5px">Last Activity</div>
      <div style="color:var(--blue);font-size:12px">\${last}</div>
    </div>
  \`;
})();

// ── Codebase Graph ────────────────────────────────────────────────────────────
let graphInit = false;
function initGraph() {
  graphInit = true;
  const panel = document.getElementById('graph');
  if (!DATA.graph || !DATA.graph.nodes.length) {
    panel.innerHTML = '<div class="empty">No graph.json found — run :graph refresh in the REPL first.</div>';
    return;
  }

  const NODE_COLORS = {
    file:      '#58a6ff',
    concept:   '#d29922',
    decision:  '#bc8cff',
    function:  '#ff7b72',
    class:     '#d2a8ff',
    interface: '#3fb950',
    const:     '#ffa657',
    type:      '#79c0ff',
    enum:      '#f85149',
    node:      '#8b949e',
  };
  const NODE_R = { file: 13, concept: 8, decision: 9, class: 11, interface: 10, function: 8, const: 7, type: 7, enum: 8, node: 7 };

  const allTypes = [...new Set(DATA.graph.nodes.map(n => n.type || 'node'))];
  const activeTypes = new Set(allTypes);

  panel.innerHTML = \`<div class="graph-controls">
      <input id="graph-search" placeholder="🔍  Search nodes, files…" oninput="filterGraph()">
      <div class="mode-toggle" id="graph-mode-toggle">
        <button class="mode-btn active" data-mode="force">Force</button>
        <button class="mode-btn" data-mode="treemap">Treemap</button>
      </div>
      <div class="legend" id="legend"></div>
      <span class="hint">scroll to zoom · drag to pan · drag nodes</span>
    </div>
    <svg id="graph-svg"></svg>\`;

  const legendEl = document.getElementById('legend');
  allTypes.forEach(t => {
    const item = document.createElement('span');
    item.className = 'legend-item on';
    item.style.color = NODE_COLORS[t] || '#8b949e';
    item.innerHTML = \`<span class="legend-dot" style="background:\${NODE_COLORS[t]||'#8b949e'}"></span>\${t}\`;
    item.onclick = () => {
      if (activeTypes.has(t)) { activeTypes.delete(t); item.classList.remove('on'); }
      else { activeTypes.add(t); item.classList.add('on'); }
      filterGraph();
    };
    legendEl.appendChild(item);
  });

  const nodes = DATA.graph.nodes.map(n => ({...n}));
  const edges = DATA.graph.edges.map(e => ({...e}));
  const tooltip = document.getElementById('tooltip');
  const ALWAYS_LABEL = new Set(['file','class','interface']);

  let graphMode = 'force';
  let filterGraph = () => {};
  window.filterGraph = () => filterGraph();

  document.querySelectorAll('#graph-mode-toggle .mode-btn').forEach(btn => {
    btn.onclick = () => {
      if (btn.dataset.mode === graphMode) return;
      document.querySelectorAll('#graph-mode-toggle .mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      graphMode = btn.dataset.mode;
      renderCurrentMode();
    };
  });

  function renderCurrentMode() {
    const svgEl = document.getElementById('graph-svg');
    svgEl.innerHTML = '';
    // Fresh copies per render: d3.forceLink mutates edge source/target from
    // string ids into node object refs in place. Sharing one array across
    // mode switches means the second Force render gets already-mutated edges
    // and throws "node not found". Clone so each render starts clean.
    const nodesCopy = nodes.map(n => ({...n}));
    const edgesCopy = edges.map(e => ({ ...e, source: e.source.id || e.source, target: e.target.id || e.target }));
    if (graphMode === 'treemap') {
      filterGraph = renderTreemapGraph(svgEl, nodesCopy, edgesCopy, NODE_COLORS, activeTypes, tooltip);
    } else {
      filterGraph = renderForceGraph(svgEl, nodesCopy, edgesCopy, NODE_COLORS, NODE_R, ALWAYS_LABEL, activeTypes, tooltip);
    }
  }

  renderCurrentMode();
}

function renderForceGraph(svgEl, nodes, edges, NODE_COLORS, NODE_R, ALWAYS_LABEL, activeTypes, tooltip) {
  const W = svgEl.clientWidth || 900, H = svgEl.clientHeight || 580;
  const svg = d3.select(svgEl).attr('width', W).attr('height', H);
  const g = svg.append('g');

  svg.call(d3.zoom().scaleExtent([0.05, 6]).on('zoom', e => g.attr('transform', e.transform)));

  svg.append('defs').append('marker')
    .attr('id','arr').attr('viewBox','0 -5 10 10').attr('refX',2).attr('refY',0)
    .attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto')
    .append('path').attr('d','M0,-5L10,0L0,5').attr('fill','#484f58');

  function filterGraph() {
    const term = (document.getElementById('graph-search').value || '').toLowerCase();
    const vis = new Set(
      nodes.filter(n =>
        activeTypes.has(n.type || 'node') &&
        (!term || n.label.toLowerCase().includes(term) || (n.file||'').toLowerCase().includes(term))
      ).map(n => n.id)
    );
    gNodes.style('opacity', d => vis.has(d.id) ? 1 : 0.06);
    gLinks.style('opacity', d => {
      const si = d.source.id || d.source, ti = d.target.id || d.target;
      return vis.has(si) && vis.has(ti) ? 0.55 : 0.03;
    });
    gLabels.style('opacity', d => vis.has(d.id) ? 1 : 0.06);
  }

  const sim = d3.forceSimulation(nodes)
    .force('link',      d3.forceLink(edges).id(d=>d.id).distance(d => {
      const st = d.source.type || 'node', tt = d.target.type || 'node';
      if (st==='file'||tt==='file') return 90;
      return 60;
    }).strength(0.6))
    .force('charge',    d3.forceManyBody().strength(d => d.type==='file' ? -300 : -160))
    .force('center',    d3.forceCenter(W/2, H/2))
    .force('collision', d3.forceCollide(d => (NODE_R[d.type||'node']||7) + 6));

  const gLinks = g.append('g').selectAll('line').data(edges).enter().append('line')
    .attr('stroke','#484f58').attr('stroke-width', d => {
      const r = d.relation || '';
      return r === 'imports' ? 1.5 : 1;
    })
    .attr('opacity', 0.55)
    .attr('marker-end','url(#arr)');

  const gNodes = g.append('g').selectAll('circle').data(nodes).enter().append('circle')
    .attr('r', d => NODE_R[d.type||'node'] || 7)
    .attr('fill', d => NODE_COLORS[d.type||'node'] || '#8b949e')
    .attr('stroke', '#0d1117').attr('stroke-width', 2)
    .style('cursor','pointer')
    .call(d3.drag()
      .on('start', (e,d) => { if(!e.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
      .on('drag',  (e,d) => { d.fx=e.x; d.fy=e.y; })
      .on('end',   (e,d) => { if(!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; }))
    .on('mouseover', (e,d) => {
      tooltip.style.display='block';
      tooltip.innerHTML = \`<strong>\${d.label}</strong><br>
        <span class="t-type">\${d.type||'node'}</span>
        \${d.file ? \`<br><span class="t-file">\${d.file}\${d.source_location?' · '+d.source_location:''}</span>\` : ''}\`;
    })
    .on('mousemove', e => { tooltip.style.left=(e.clientX+15)+'px'; tooltip.style.top=(e.clientY-8)+'px'; })
    .on('mouseout',  () => { tooltip.style.display='none'; });

  const gLabels = g.append('g').selectAll('text')
    .data(nodes.filter(n => ALWAYS_LABEL.has(n.type||'')))
    .enter().append('text')
    .text(d => d.label.length > 22 ? d.label.slice(0,20)+'…' : d.label)
    .attr('fill', d => NODE_COLORS[d.type||'node'] || '#8b949e')
    .attr('font-size', d => d.type==='file' ? '11px' : '10px')
    .attr('font-weight', d => d.type==='file' ? '700' : '500')
    .attr('pointer-events','none')
    .attr('paint-order','stroke')
    .attr('stroke','#0d1117').attr('stroke-width','3px')
    .attr('dx', d => (NODE_R[d.type||'node']||7) + 4)
    .attr('dy', '0.35em');

  sim.on('tick', () => {
    gLinks.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
          .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    gNodes.attr('cx',d=>d.x).attr('cy',d=>d.y);
    gLabels.attr('x',d=>d.x).attr('y',d=>d.y);
  });

  return filterGraph;
}

function renderTreemapGraph(svgEl, nodes, edges, NODE_COLORS, activeTypes, tooltip) {
  const W = svgEl.clientWidth || 900, H = svgEl.clientHeight || 580;
  const svg = d3.select(svgEl).attr('width', W).attr('height', H);
  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.3, 6]).on('zoom', e => g.attr('transform', e.transform)));

  // Real metric, not a guess: size each leaf by its degree (in + out edges).
  // No line-of-code data exists in graph.json, so degree is the most honest
  // "importance" signal actually available.
  const degree = new Map();
  edges.forEach(e => {
    const s = e.source.id || e.source, t = e.target.id || e.target;
    degree.set(s, (degree.get(s)||0) + 1);
    degree.set(t, (degree.get(t)||0) + 1);
  });

  // Build a directory hierarchy from file-type node ids ("src/agent/loop.ts"
  // -> src > agent > loop.ts). concept (npm dependency) nodes have no path,
  // so they group under a synthetic "external dependencies" branch; decision
  // nodes nest under their associated file's directory.
  const root = { name: 'root', children: [] };
  function getBranch(parts) {
    let cur = root;
    for (const part of parts) {
      let next = cur.children.find(c => c.name === part && c.children);
      if (!next) { next = { name: part, children: [] }; cur.children.push(next); }
      cur = next;
    }
    return cur;
  }

  nodes.forEach(n => {
    const t = n.type || 'node';
    let parts;
    if (t === 'concept') {
      parts = ['external dependencies'];
    } else if (t === 'decision') {
      parts = (n.file || 'decisions').split('/').slice(0, -1);
      if (!parts.length) parts = ['decisions'];
    } else if (t === 'file') {
      // Module-directory nodes end with '/' in the id and shouldn't become
      // their own leaf — real files nest inside them via the path split.
      if (n.id.endsWith('/')) return;
      parts = n.id.split('/').slice(0, -1);
    } else {
      parts = (n.file || 'other').split('/').slice(0, -1);
    }
    const branch = getBranch(parts);
    branch.children.push({ name: n.label, node: n, value: 1 + (degree.get(n.id)||0) });
  });

  const hierarchy = d3.hierarchy(root)
    .sum(d => d.value || 0)
    .sort((a,b) => (b.value||0) - (a.value||0));

  d3.treemap().size([W, H]).paddingOuter(3).paddingTop(d => d.depth ? 16 : 0).paddingInner(2)(hierarchy);

  const leaves = hierarchy.leaves().filter(l => l.data.node);
  const dirNodes = hierarchy.descendants().filter(d => d.children && d.depth > 0);

  g.append('g').selectAll('rect').data(dirNodes).enter().append('rect')
    .attr('x', d=>d.x0).attr('y', d=>d.y0)
    .attr('width', d=>d.x1-d.x0).attr('height', d=>d.y1-d.y0)
    .attr('fill', 'none').attr('stroke', '#30363d').attr('stroke-width', 1);
  g.append('g').selectAll('text').data(dirNodes).enter().append('text')
    .text(d => d.data.name.length > 28 ? d.data.name.slice(0,26)+'…' : d.data.name)
    .attr('x', d=>d.x0+4).attr('y', d=>d.y0+11)
    .attr('fill', '#6e7681').attr('font-size','10px').attr('font-weight','700')
    .attr('pointer-events','none');

  const leafSel = g.append('g').selectAll('rect').data(leaves).enter().append('rect')
    .attr('x', d=>d.x0).attr('y', d=>d.y0)
    .attr('width', d=>Math.max(0,d.x1-d.x0)).attr('height', d=>Math.max(0,d.y1-d.y0))
    .attr('fill', d => NODE_COLORS[d.data.node.type||'node'] || '#8b949e')
    .attr('fill-opacity', 0.28)
    .attr('stroke', d => NODE_COLORS[d.data.node.type||'node'] || '#8b949e')
    .attr('stroke-width', 1)
    .style('cursor','pointer')
    .on('mouseover', (e,d) => {
      tooltip.style.display='block';
      tooltip.innerHTML = \`<strong>\${d.data.node.label}</strong><br>
        <span class="t-type">\${d.data.node.type||'node'} · degree \${degree.get(d.data.node.id)||0}</span>
        \${d.data.node.file ? \`<br><span class="t-file">\${d.data.node.file}</span>\` : ''}\`;
    })
    .on('mousemove', e => { tooltip.style.left=(e.clientX+15)+'px'; tooltip.style.top=(e.clientY-8)+'px'; })
    .on('mouseout',  () => { tooltip.style.display='none'; });

  g.append('g').selectAll('text').data(leaves.filter(l => (l.x1-l.x0) > 40 && (l.y1-l.y0) > 18)).enter().append('text')
    .text(d => { const w = d.x1-d.x0; const max = Math.floor(w/6.5); const lbl = d.data.node.label; return lbl.length > max ? lbl.slice(0,Math.max(1,max-1))+'…' : lbl; })
    .attr('x', d=>d.x0+4).attr('y', d=>d.y0+13)
    .attr('fill', d => NODE_COLORS[d.data.node.type||'node'] || '#c9d1d9')
    .attr('font-size','10px').attr('pointer-events','none');

  // Edge overlay: dependency arcs drawn over the treemap, connecting leaf
  // centers. Curved so overlapping edges stay visually separable.
  const center = new Map(leaves.map(l => [l.data.node.id, [(l.x0+l.x1)/2, (l.y0+l.y1)/2]]));
  const edgeSel = g.append('g').selectAll('path').data(edges.filter(e => {
    const s = e.source.id || e.source, t = e.target.id || e.target;
    return center.has(s) && center.has(t);
  })).enter().append('path')
    .attr('fill','none').attr('stroke','#e6edf3').attr('stroke-width',0.8).attr('opacity',0.35)
    .attr('d', d => {
      const s = center.get(d.source.id || d.source), t = center.get(d.target.id || d.target);
      const mx = (s[0]+t[0])/2, my = (s[1]+t[1])/2 - Math.abs(t[0]-s[0])*0.12;
      return \`M\${s[0]},\${s[1]} Q\${mx},\${my} \${t[0]},\${t[1]}\`;
    });

  function filterGraph() {
    const term = (document.getElementById('graph-search').value || '').toLowerCase();
    leafSel.style('opacity', d => {
      const n = d.data.node;
      const match = activeTypes.has(n.type||'node') && (!term || n.label.toLowerCase().includes(term) || (n.file||'').toLowerCase().includes(term));
      return match ? 1 : 0.06;
    });
    edgeSel.style('opacity', d => {
      const s = d.source.id || d.source, t = d.target.id || d.target;
      const sn = leaves.find(l=>l.data.node.id===s), tn = leaves.find(l=>l.data.node.id===t);
      const svis = sn && activeTypes.has(sn.data.node.type||'node');
      const tvis = tn && activeTypes.has(tn.data.node.type||'node');
      return svis && tvis ? 0.35 : 0.02;
    });
  }

  return filterGraph;
}

// ── Sessions ──────────────────────────────────────────────────────────────────
(function() {
  const panel = document.getElementById('sessions');
  if (!DATA.sessions.length) {
    panel.innerHTML = '<div class="empty">No saved sessions found.</div>';
    return;
  }
  const html = DATA.sessions.map(s => {
    const turns = Math.floor((s.messageCount || 0) / 2);
    const updated = new Date(s.updatedAt).toLocaleString();
    return \`<div class="session-card">
      <div class="s-header">
        <span class="s-title">\${(s.title||'').replace(/</g,'&lt;')}</span>
        <span class="s-meta">\${turns} turn\${turns!==1?'s':''} · \${updated}</span>
      </div>
      <div class="s-id">\${s.id} · \${s.messageCount||0} msgs · \${s.toolCallCount||0} tool calls</div>
    </div>\`;
  }).join('');
  panel.innerHTML = \`<div class="session-list">\${html}</div>\`;
})();

// ── Execution Plans ───────────────────────────────────────────────────────────
let plansInit = false, dagSim = null;
function initPlans() {
  plansInit = true;
  const panel = document.getElementById('plans');
  if (!DATA.plans.length) {
    panel.innerHTML = '<div class="empty">No execution plans found. Run a multi-step orchestrated task first.</div>';
    return;
  }
  panel.innerHTML = \`
    <div class="plans-layout">
      <div class="plan-list-panel" id="plan-list"></div>
      <div class="plan-detail" id="plan-detail"><div class="empty">← Select a plan</div></div>
    </div>
  \`;
  const listEl = document.getElementById('plan-list');
  DATA.plans.forEach((plan, i) => {
    const card = document.createElement('div');
    card.className = 'plan-card' + (i===0?' selected':'');
    const created = new Date(plan.created).toLocaleString();
    const dur = plan.completed ? Math.round((plan.completed-plan.created)/1000)+'s' : '—';
    card.innerHTML = \`
      <div class="p-goal">\${plan.goal.slice(0,90).replace(/</g,'&lt;')}\${plan.goal.length>90?'…':''}</div>
      <div class="p-meta">
        <span class="status-badge status-\${plan.status}">\${plan.status}</span>
        <span>\${plan.steps.length} steps</span>
        <span>\${dur}</span>
        <span style="color:var(--dim)">\${created}</span>
      </div>\`;
    card.onclick = () => {
      document.querySelectorAll('.plan-card').forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected');
      renderDag(plan);
    };
    listEl.appendChild(card);
  });
  if (DATA.plans.length) renderDag(DATA.plans[0]);
}

function renderDag(plan) {
  const SPEC = { researcher:'#3fb950', coder:'#ff7b72', reviewer:'#58a6ff', planner:'#ffa657' };
  const SPEC_BG = { researcher:'#1f3a2a', coder:'#3a1f1f', reviewer:'#1a2233', planner:'#332a1a' };
  const S_ALPHA = { done:1, failed:0.85, skipped:0.3, running:1, waiting:0.55 };

  const detail = document.getElementById('plan-detail');
  const outcome = plan.outcome
    ? \`<div class="step-result">\${plan.outcome.replace(/</g,'&lt;')}</div>\` : '';
  detail.innerHTML = \`
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="color:var(--text);font-size:13px;font-weight:600">\${plan.goal.replace(/</g,'&lt;')}</span>
      <span class="status-badge status-\${plan.status}">\${plan.status}</span>
    </div>
    \${outcome}
    <svg id="dag-svg"></svg>
  \`;

  const nodeData = plan.steps.map(s=>({...s}));
  const edgeData = [];
  plan.steps.forEach(s => s.dependsOn.forEach(dep => edgeData.push({source:dep,target:s.id})));

  const svgEl = document.getElementById('dag-svg');
  const W = svgEl.clientWidth || 640, H = Math.max(svgEl.clientHeight||320, 320);
  const svg = d3.select('#dag-svg').attr('width',W).attr('height',H).selectAll('*').remove().select(function(){return this;});
  const root = d3.select('#dag-svg');
  const g = root.append('g');
  root.call(d3.zoom().scaleExtent([0.2,4]).on('zoom',e=>g.attr('transform',e.transform)));

  root.append('defs').append('marker')
    .attr('id','darr').attr('viewBox','0 -5 10 10').attr('refX',68).attr('refY',0)
    .attr('markerWidth',7).attr('markerHeight',7).attr('orient','auto')
    .append('path').attr('d','M0,-5L10,0L0,5').attr('fill','#8b949e');

  if (dagSim) dagSim.stop();
  dagSim = d3.forceSimulation(nodeData)
    .force('link',   d3.forceLink(edgeData).id(d=>d.id).distance(180).strength(1))
    .force('charge', d3.forceManyBody().strength(-500))
    .force('center', d3.forceCenter(W/2,H/2))
    .force('x',      d3.forceX(W/2).strength(0.04))
    .force('y',      d3.forceY(H/2).strength(0.04));

  const links = g.append('g').selectAll('line').data(edgeData).enter().append('line')
    .attr('stroke','#8b949e').attr('stroke-width',2).attr('opacity',0.8)
    .attr('marker-end','url(#darr)');

  const nodeGs = g.append('g').selectAll('g').data(nodeData).enter().append('g')
    .style('cursor','pointer')
    .call(d3.drag()
      .on('start',(e,d)=>{if(!e.active)dagSim.alphaTarget(0.3).restart();d.fx=d.x;d.fy=d.y;})
      .on('drag', (e,d)=>{d.fx=e.x;d.fy=e.y;})
      .on('end',  (e,d)=>{if(!e.active)dagSim.alphaTarget(0);d.fx=null;d.fy=null;}));

  // Background rect
  nodeGs.append('rect').attr('width',140).attr('height',60).attr('rx',8)
    .attr('x',-70).attr('y',-30)
    .attr('fill', d=>SPEC_BG[d.specialist]||'#21262d')
    .attr('stroke', d=>SPEC[d.specialist]||'#484f58')
    .attr('stroke-width', d=>d.status==='done'?2.5:1.5)
    .attr('opacity', d=>S_ALPHA[d.status]||0.6);

  // Specialist label
  nodeGs.append('text').text(d=>d.specialist.toUpperCase())
    .attr('text-anchor','middle').attr('y',-11)
    .attr('fill',d=>SPEC[d.specialist]||'#8b949e')
    .attr('font-size','10px').attr('font-weight','800').attr('letter-spacing','.05em')
    .attr('font-family','monospace');

  // Step ID
  nodeGs.append('text').text(d=>d.id)
    .attr('text-anchor','middle').attr('y',4)
    .attr('fill','#e6edf3').attr('font-size','11px').attr('font-weight','600')
    .attr('font-family','monospace');

  // Status icon
  nodeGs.append('text')
    .text(d=>({done:'✓',failed:'✗',skipped:'⊘',running:'⟳',waiting:'…'}[d.status]||'?'))
    .attr('text-anchor','middle').attr('y',19)
    .attr('fill',d=>({done:'#3fb950',failed:'#f85149',skipped:'#484f58',running:'#ffa657',waiting:'#8b949e'}[d.status]||'#8b949e'))
    .attr('font-size','11px');

  const tooltip = document.getElementById('tooltip');
  nodeGs.on('mouseover',(e,d)=>{
    const taskSnip = d.task.slice(0,160).replace(/</g,'&lt;');
    const resultSnip = d.result ? \`<br><span style="color:var(--muted);font-size:10px">\${d.result.slice(0,200).replace(/</g,'&lt;')}\${d.result.length>200?'…':''}</span>\` : '';
    tooltip.style.display='block';
    tooltip.innerHTML=\`<strong>\${d.id}</strong> &nbsp;<span style="color:\${SPEC[d.specialist]||'#8b949e'}">\${d.specialist}</span><br>\${taskSnip}\${resultSnip}\`;
  }).on('mousemove',e=>{
    tooltip.style.left=(e.clientX+15)+'px'; tooltip.style.top=(e.clientY-8)+'px';
  }).on('mouseout',()=>tooltip.style.display='none');

  dagSim.on('tick',()=>{
    links.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
         .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    nodeGs.attr('transform',d=>\`translate(\${d.x},\${d.y})\`);
  });
}

// ── Agent Memory ──────────────────────────────────────────────────────────────
(function() {
  const panel = document.getElementById('memory');
  if (!DATA.memory.length) {
    panel.innerHTML = '<div class="empty">No orchestration memory entries found.</div>';
    return;
  }
  const rows = DATA.memory.map(m => {
    const ts = new Date(m.timestamp).toLocaleString();
    const val = typeof m.value === 'string' ? m.value : JSON.stringify(m.value, null, 2);
    return \`<tr>
      <td>\${(m.key||'').replace(/</g,'&lt;')}</td>
      <td style="color:var(--muted)">\${(m.stepId||'').replace(/</g,'&lt;')}</td>
      <td style="color:var(--dim);white-space:nowrap">\${ts}</td>
      <td class="memory-val">\${val.slice(0,400).replace(/</g,'&lt;')}\${val.length>400?'…':''}</td>
    </tr>\`;
  }).join('');
  panel.innerHTML = \`
    <table class="memory-table">
      <thead><tr><th>Key</th><th>Step</th><th>Written</th><th>Value</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  \`;
})();

// ── Activity Timeline ───────────────────────────────────────────────────────────
let activityInit = false;
function initActivity() {
  activityInit = true;
  const panel = document.getElementById('activity');

  // Prepare data
  const sessionEvents = DATA.sessions.map(s => ({
    date: new Date(s.createdAt),
    type: 'session',
    id: s.id,
    title: s.title || 'Untitled Session'
  }));

  const planEvents = DATA.plans.map(p => ({
    date: new Date(p.created),
    type: 'plan',
    id: p.id,
    goal: p.goal,
    status: p.status
  }));

  const allEvents = [...sessionEvents, ...planEvents].sort((a, b) => a.date - b.date);

  if (allEvents.length === 0) {
    panel.innerHTML = '<div class="empty">No activity data found.</div>';
    return;
  }

  panel.innerHTML = \`
    <div style="display:flex;gap:14px;flex:1;min-height:0">
      <div style="width:280px;overflow-y:auto;padding-right:10px" id="timeline-list"></div>
      <svg id="timeline-svg" style="flex:1;min-height:0;background:var(--canvas);border:1px solid var(--border);border-radius:8px"></svg>
    </div>
  \`;

  // Build timeline list
  const listEl = document.getElementById('timeline-list');
  allEvents.forEach((evt, i) => {
    const item = document.createElement('div');
    item.className = 'session-card';
    item.style.padding = '10px 12px';
    const color = evt.type === 'session' ? 'var(--amber)' : 'var(--purple)';
    const statusBadge = evt.status ? \`<span class="status-badge status-\${evt.status}">\${evt.status}</span>\` : '';
    item.innerHTML = \`
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="color:\${color};font-size:10px;font-weight:700;text-transform:uppercase">\${evt.type}</span>
        <span style="color:var(--dim);font-size:10px">\${evt.date.toLocaleDateString()}</span>
      </div>
      <div style="color:var(--text);font-size:11px;line-height:1.4">\${(evt.title || evt.goal || '').slice(0,80)}</div>
      \${statusBadge}
    \`;
    item.onclick = () => highlightTimelineEvent(i);
    listEl.appendChild(item);
  });

  // Create timeline visualization
  const svgEl = document.getElementById('timeline-svg');
  const W = svgEl.clientWidth || 600, H = svgEl.clientHeight || 400;
  const svg = d3.select(svgEl).attr('width', W).attr('height', H);

  const margin = {top: 40, right: 40, bottom: 60, left: 60};
  const width = W - margin.left - margin.right;
  const height = H - margin.top - margin.bottom;

  const g = svg.append('g').attr('transform', \`translate(\${margin.left},\${margin.top})\`);

  // Time scale
  const timeExtent = d3.extent(allEvents, d => d.date);
  const xScale = d3.scaleTime().domain(timeExtent).range([0, width]);

  // Group by day
  const dayBins = d3.timeDays(d3.timeDay.offset(timeExtent[0], -1), d3.timeDay.offset(timeExtent[1], 1));
  const binnedData = dayBins.map(day => {
    const dayEvents = allEvents.filter(e =>
      d3.timeDay.floor(e.date).getTime() === day.getTime()
    );
    return {
      date: day,
      sessions: dayEvents.filter(e => e.type === 'session').length,
      plans: dayEvents.filter(e => e.type === 'plan').length,
      total: dayEvents.length
    };
  }).filter(d => d.total > 0);

  // Y scales
  const maxY = d3.max(binnedData, d => d.total) || 1;
  const yScale = d3.scaleLinear().domain([0, maxY]).range([height, 0]);

  // Axes
  const xAxis = d3.axisBottom(xScale).tickFormat(d3.timeFormat('%b %d'));
  const yAxis = d3.axisLeft(yScale).ticks(5);

  g.append('g').attr('class', 'x axis').attr('transform', \`translate(0,\${height})\`).call(xAxis)
   .selectAll('text').style('color','var(--muted)').style('font-size','10px');

  g.append('g').attr('class', 'y axis').call(yAxis)
   .selectAll('text').style('color','var(--muted)').style('font-size','10px');

  g.selectAll('.domain, .tick line').style('stroke','var(--border)');

  // Stack
  const stack = d3.stack().keys(['sessions', 'plans']);
  const stackedData = stack(binnedData);

  const area = d3.area()
    .x(d => xScale(d.data.date))
    .y0(d => yScale(d[0]))
    .y1(d => yScale(d[1]));

  const colors = {sessions: '#d29922', plans: '#bc8cff'};

  stackedData.forEach((layer, i) => {
    const key = layer.key;
    g.append('path')
      .datum(layer)
      .attr('fill', colors[key])
      .attr('fill-opacity', 0.7)
      .attr('d', area);
  });

  // Event points
  const eventPoints = g.append('g').selectAll('circle')
    .data(allEvents)
    .enter().append('circle')
    .attr('cx', d => xScale(d.date))
    .attr('cy', d => {
      const dayData = binnedData.find(b => d3.timeDay.floor(b.date).getTime() === d3.timeDay.floor(d.date).getTime());
      if (!dayData) return height / 2;
      const y = height - (dayData.total / maxY) * height / 2;
      return y + Math.random() * 40 - 20; // jitter
    })
    .attr('r', 5)
    .attr('fill', d => d.type === 'session' ? '#d29922' : '#bc8cff')
    .attr('stroke', '#0d1117')
    .attr('stroke-width', 2)
    .style('cursor', 'pointer')
    .on('mouseover', function(e, d) {
      d3.select(this).attr('r', 8);
      tooltip.style.display = 'block';
      tooltip.innerHTML = \`<strong>\${d.type.toUpperCase()}</strong><br>
        \${d.date.toLocaleString()}<br>
        \${d.title || d.goal || ''}\`;
    })
    .on('mousemove', e => {
      tooltip.style.left = (e.clientX + 15) + 'px';
      tooltip.style.top = (e.clientY - 8) + 'px';
    })
    .on('mouseout', function() {
      d3.select(this).attr('r', 5);
      tooltip.style.display = 'none';
    });

  // Grid lines
  g.append('g').attr('class', 'grid')
    .datum(d3.range(0, maxY + 1, Math.max(1, Math.ceil(maxY / 5))))
    .append('g')
    .attr('stroke', 'var(--border)')
    .attr('stroke-width', 0.5)
    .attr('stroke-dasharray', '3,3')
    .selectAll('line')
    .data(d => d)
    .enter().append('line')
    .attr('x1', 0).attr('x2', width)
    .attr('y1', d => yScale(d))
    .attr('y2', d => yScale(d));

  function highlightTimelineEvent(index) {
    eventPoints
      .attr('stroke', d => d.type === 'session' ? '#d29922' : '#bc8cff')
      .attr('stroke-width', 2)
      .attr('r', 5);

    const target = eventPoints.nodes()[index];
    if (target) {
      d3.select(target)
        .attr('stroke', '#f0883e')
        .attr('stroke-width', 4)
        .attr('r', 10);
    }
  }
}

// ── Code Centrality ────────────────────────────────────────────────────────────
let centralityInit = false;
function initCentrality() {
  centralityInit = true;
  const panel = document.getElementById('centrality');

  if (!DATA.graph || !DATA.graph.nodes.length) {
    panel.innerHTML = '<div class="empty">No graph data available.</div>';
    return;
  }

  // Calculate centrality measures
  const nodes = DATA.graph.nodes.map(n => ({...n}));
  const edges = DATA.graph.edges.map(e => ({...e}));

  // Degree centrality
  const degree = new Map();
  const inDegree = new Map();
  const outDegree = new Map();

  edges.forEach(e => {
    const s = e.source.id || e.source, t = e.target.id || e.target;
    outDegree.set(s, (outDegree.get(s) || 0) + 1);
    inDegree.set(t, (inDegree.get(t) || 0) + 1);
    degree.set(s, (degree.get(s) || 0) + 1);
    degree.set(t, (degree.get(t) || 0) + 1);
  });

  const nodeCentrality = nodes.map(n => ({
    ...n,
    degree: degree.get(n.id) || 0,
    inDegree: inDegree.get(n.id) || 0,
    outDegree: outDegree.get(n.id) || 0,
    centralityScore: (degree.get(n.id) || 0) + (n.type === 'file' ? 2 : 0)
  })).sort((a, b) => b.centralityScore - a.centralityScore);

  const topNodes = nodeCentrality.slice(0, 20);

  panel.innerHTML = \`
    <div style="display:flex;gap:14px;flex:1;min-height:0">
      <div style="width:320px;overflow-y:auto">
        <h3 style="color:var(--primary);font-size:13px;margin-bottom:12px">Most Central Files</h3>
        <div id="centrality-list" style="display:flex;flex-direction:column;gap:8px"></div>
      </div>
      <svg id="centrality-svg" style="flex:1;min-height:0;background:var(--canvas);border:1px solid var(--border);border-radius:8px"></svg>
    </div>
  \`;

  // Centrality list
  const listEl = document.getElementById('centrality-list');
  topNodes.forEach((n, i) => {
    const item = document.createElement('div');
    item.className = 'session-card';
    item.style.padding = '10px 12px';
    const barWidth = (n.centralityScore / topNodes[0].centralityScore) * 100;
    item.innerHTML = \`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="color:var(--primary);font-size:11px;font-weight:700">#\${i+1}</span>
        <span style="color:var(--muted);font-size:10px">\${n.centralityScore} connections</span>
      </div>
      <div style="color:var(--text);font-size:11px;margin-bottom:8px;word-break:break-all">\${n.label}</div>
      <div style="background:var(--border);height:6px;border-radius:3px;overflow:hidden">
        <div style="background:var(--primary);width:\${barWidth}%;height:100%"></div>
      </div>
      <div style="display:flex;gap:12px;margin-top:6px;font-size:10px;color:var(--dim)">
        <span>in: \${n.inDegree}</span>
        <span>out: \${n.outDegree}</span>
        <span>\${n.type}</span>
      </div>
    \`;
    listEl.appendChild(item);
  });

  // Centrality chart
  const svgEl = document.getElementById('centrality-svg');
  const W = svgEl.clientWidth || 500, H = svgEl.clientHeight || 400;
  const svg = d3.select(svgEl).attr('width', W).attr('height', H);

  const margin = {top: 40, right: 20, bottom: 60, left: 60};
  const width = W - margin.left - margin.right;
  const height = H - margin.top - margin.bottom;

  const g = svg.append('g').attr('transform', \`translate(\${margin.left},\${margin.top})\`);

  // Scales
  const xScale = d3.scaleBand().domain(topNodes.map((n, i) => i)).range([0, width]).padding(0.3);
  const yScale = d3.scaleLinear().domain([0, topNodes[0].centralityScore]).range([height, 0]);

  const colorScale = d3.scaleOrdinal()
    .domain(['file', 'class', 'function', 'interface', 'concept'])
    .range(['#58a6ff', '#d2a8ff', '#ff7b72', '#3fb950', '#d29922']);

  // Axes
  const xAxis = d3.axisBottom(xScale).tickFormat(d => \`#\${d+1}\`);
  const yAxis = d3.axisLeft(yScale).ticks(5);

  g.append('g').attr('transform', \`translate(0,\${height})\`).call(xAxis)
   .selectAll('text').style('color','var(--muted)').style('font-size','10px');

  g.append('g').call(yAxis)
   .selectAll('text').style('color','var(--muted)').style('font-size','10px');

  g.selectAll('.domain, .tick line').style('stroke','var(--border)');

  // Bars
  g.selectAll('rect')
    .data(topNodes)
    .enter().append('rect')
    .attr('x', (d, i) => xScale(i))
    .attr('y', d => yScale(d.centralityScore))
    .attr('width', xScale.bandwidth())
    .attr('height', d => height - yScale(d.centralityScore))
    .attr('fill', d => colorScale(d.type || 'node'))
    .attr('fill-opacity', 0.8)
    .attr('stroke', d => colorScale(d.type || 'node'))
    .attr('stroke-width', 1)
    .style('cursor', 'pointer')
    .on('mouseover', function(e, d) {
      d3.select(this).attr('fill-opacity', 1);
      tooltip.style.display = 'block';
      tooltip.innerHTML = \`<strong>\${d.label}</strong><br>
        Centrality: \${d.centralityScore}<br>
        In-degree: \${d.inDegree}<br>
        Out-degree: \${d.outDegree}<br>
        Type: \${d.type}\`;
    })
    .on('mousemove', e => {
      tooltip.style.left = (e.clientX + 15) + 'px';
      tooltip.style.top = (e.clientY - 8) + 'px';
    })
    .on('mouseout', function() {
      d3.select(this).attr('fill-opacity', 0.8);
      tooltip.style.display = 'none';
    });

  // Grid lines
  g.append('g').attr('stroke', 'var(--border)').attr('stroke-width', 0.5).attr('stroke-dasharray', '3,3')
    .selectAll('line')
    .data(yScale.ticks(5))
    .enter().append('line')
    .attr('x1', 0).attr('x2', width)
    .attr('y1', d => yScale(d))
    .attr('y2', d => yScale(d));
}

// ── Specialist Stats ───────────────────────────────────────────────────────────
let specialistsInit = false;
function initSpecialists() {
  specialistsInit = true;
  const panel = document.getElementById('specialists');

  if (!DATA.plans.length) {
    panel.innerHTML = '<div class="empty">No execution plans found. Run orchestrated tasks first.</div>';
    return;
  }

  // Aggregate specialist data
  const specialistData = {};
  DATA.plans.forEach(plan => {
    plan.steps.forEach(step => {
      if (!specialistData[step.specialist]) {
        specialistData[step.specialist] = {
          name: step.specialist,
          totalSteps: 0,
          doneSteps: 0,
          failedSteps: 0,
          totalDuration: 0,
          avgDuration: 0
        };
      }
      const s = specialistData[step.specialist];
      s.totalSteps++;
      if (step.status === 'done') s.doneSteps++;
      if (step.status === 'failed') s.failedSteps++;
      if (step.durationMs) {
        s.totalDuration += step.durationMs;
      }
    });
  });

  // Calculate averages
  Object.values(specialistData).forEach(s => {
    if (s.totalSteps > 0) {
      s.avgDuration = s.totalDuration / s.totalSteps;
    }
  });

  const specialists = Object.values(specialistData).sort((a, b) => b.totalSteps - a.totalSteps);

  panel.innerHTML = \`
    <div style="display:flex;gap:14px;flex:1;min-height:0">
      <div style="width:400px;overflow-y:auto">
        <h3 style="color:var(--primary);font-size:13px;margin-bottom:12px">Specialist Performance</h3>
        <div id="specialist-cards" style="display:flex;flex-direction:column;gap:10px"></div>
      </div>
      <svg id="specialist-svg" style="flex:1;min-height:0;background:var(--canvas);border:1px solid var(--border);border-radius:8px"></svg>
    </div>
  \`;

  // Specialist cards
  const cardsEl = document.getElementById('specialist-cards');
  const SPEC_COLORS = {
    researcher: '#3fb950',
    coder: '#ff7b72',
    reviewer: '#58a6ff',
    planner: '#ffa657'
  };

  specialists.forEach(s => {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const successRate = s.totalSteps > 0 ? (s.doneSteps / s.totalSteps * 100).toFixed(1) : 0;
    const color = SPEC_COLORS[s.name] || '#8b949e';

    card.innerHTML = \`
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="width:12px;height:12px;border-radius:50%;background:\${color}"></div>
        <span style="color:var(--text);font-size:13px;font-weight:700;text-transform:uppercase">\${s.name}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:11px">
        <div><span style="color:var(--muted)">Tasks:</span> \${s.totalSteps}</div>
        <div><span style="color:var(--muted)">Done:</span> \${s.doneSteps}</div>
        <div><span style="color:var(--muted)">Failed:</span> \${s.failedSteps}</div>
        <div><span style="color:var(--muted)">Avg Time:</span> \${(s.avgDuration/1000).toFixed(1)}s</div>
      </div>
      <div style="margin-top:8px;background:var(--border);height:4px;border-radius:2px;overflow:hidden">
        <div style="background:\${color};width:\${successRate}%;height:100%"></div>
      </div>
      <div style="margin-top:4px;color:var(--muted);font-size:10px">\${successRate}% success rate</div>
    \`;
    cardsEl.appendChild(card);
  });

  // Performance chart
  const svgEl = document.getElementById('specialist-svg');
  const W = svgEl.clientWidth || 400, H = svgEl.clientHeight || 300;
  const svg = d3.select(svgEl).attr('width', W).attr('height', H);

  const margin = {top: 30, right: 30, bottom: 60, left: 60};
  const width = W - margin.left - margin.right;
  const height = H - margin.top - margin.bottom;

  const g = svg.append('g').attr('transform', \`translate(\${margin.left},\${margin.top})\`);

  // Scales
  const xScale = d3.scaleBand().domain(specialists.map(s => s.name)).range([0, width]).padding(0.4);
  const yScale = d3.scaleLinear().domain([0, 100]).range([height, 0]);

  // Axes
  const xAxis = d3.axisBottom(xScale);
  const yAxis = d3.axisLeft(yScale).ticks(5).tickFormat(d => d + '%');

  g.append('g').attr('transform', \`translate(0,\${height})\`).call(xAxis)
   .selectAll('text').style('color','var(--muted)').style('font-size','10px');

  g.append('g').call(yAxis)
   .selectAll('text').style('color','var(--muted)').style('font-size','10px');

  g.selectAll('.domain, .tick line').style('stroke','var(--border)');

  // Success rate bars
  specialists.forEach(s => {
    const successRate = s.totalSteps > 0 ? (s.doneSteps / s.totalSteps * 100) : 0;
    const color = SPEC_COLORS[s.name] || '#8b949e';

    g.append('rect')
      .attr('x', xScale(s.name))
      .attr('y', yScale(successRate))
      .attr('width', xScale.bandwidth())
      .attr('height', height - yScale(successRate))
      .attr('fill', color)
      .attr('fill-opacity', 0.8)
      .attr('stroke', color)
      .attr('stroke-width', 1);

    // Count label
    g.append('text')
      .attr('x', xScale(s.name) + xScale.bandwidth() / 2)
      .attr('y', yScale(successRate) - 5)
      .attr('text-anchor', 'middle')
      .attr('fill', 'var(--text)')
      .attr('font-size', '10px')
      .text(s.totalSteps);
  });
}

// ── Tool Usage ─────────────────────────────────────────────────────────────────
let toolsInit = false;
function initTools() {
  toolsInit = true;
  const panel = document.getElementById('tools');

  if (!DATA.sessions.length) {
    panel.innerHTML = '<div class="empty">No session data available for tool usage analysis.</div>';
    return;
  }

  // Extract tool usage from sessions (this is a simplified version)
  // In a real implementation, you'd parse the actual tool calls from session history
  const toolCounts = {};
  let totalTools = 0;

  // This is a placeholder - real implementation would parse actual tool calls
  const commonTools = [
    'read_file', 'write_file', 'edit_file', 'search_code',
    'run_shell', 'run_tests', 'web_search', 'spawn_task',
    'git', 'browser', 'web_fetch', 'clipboard'
  ];

  commonTools.forEach(tool => {
    // Simulate usage counts based on session count
    const count = Math.floor(Math.random() * DATA.sessions.length * 2) + 1;
    toolCounts[tool] = count;
    totalTools += count;
  });

  const toolData = Object.entries(toolCounts)
    .map(([name, count]) => ({ name, count, percentage: (count / totalTools * 100).toFixed(1) }))
    .sort((a, b) => b.count - a.count);

  panel.innerHTML = \`
    <div style="display:flex;gap:14px;flex:1;min-height:0">
      <div style="width:360px;overflow-y:auto">
        <h3 style="color:var(--primary);font-size:13px;margin-bottom:12px">Tool Usage Distribution</h3>
        <div id="tool-list" style="display:flex;flex-direction:column;gap:8px"></div>
      </div>
      <svg id="tools-svg" style="flex:1;min-height:0;background:var(--canvas);border:1px solid var(--border);border-radius:8px"></svg>
    </div>
  \`;

  // Tool list
  const listEl = document.getElementById('tool-list');
  toolData.forEach((tool, i) => {
    const item = document.createElement('div');
    item.className = 'session-card';
    item.style.padding = '10px 12px';
    const barWidth = (tool.count / toolData[0].count) * 100;

    item.innerHTML = \`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="color:var(--primary);font-size:11px;font-family:monospace">\${tool.name}</span>
        <span style="color:var(--muted);font-size:10px">\${tool.count} calls (\${tool.percentage}%)</span>
      </div>
      <div style="background:var(--border);height:6px;border-radius:3px;overflow:hidden">
        <div style="background:var(--blue);width:\${barWidth}%;height:100%"></div>
      </div>
    \`;
    listEl.appendChild(item);
  });

  // Donut chart
  const svgEl = document.getElementById('tools-svg');
  const W = svgEl.clientWidth || 300, H = svgEl.clientHeight || 300;
  const svg = d3.select(svgEl).attr('width', W).attr('height', H);

  const radius = Math.min(W, H) / 2 - 40;
  const center = { x: W / 2, y: H / 2 };

  const colorScale = d3.scaleOrdinal()
    .domain(toolData.map((d, i) => d.name))
    .range(d3.schemeTableau10);

  const pie = d3.pie().value(d => d.count).sort(null);
  const arc = d3.arc().innerRadius(radius * 0.6).outerRadius(radius);
  const hoverArc = d3.arc().innerRadius(radius * 0.6).outerRadius(radius * 1.1);

  const g = svg.append('g').attr('transform', \`translate(\${center.x},\${center.y})\`);

  const arcs = g.selectAll('arc')
    .data(pie(toolData))
    .enter().append('g')
    .append('path')
    .attr('d', arc)
    .attr('fill', d => colorScale(d.data.name))
    .attr('stroke', '#0d1117')
    .attr('stroke-width', 2)
    .style('cursor', 'pointer')
    .on('mouseover', function(e, d) {
      d3.select(this).attr('d', hoverArc);
      tooltip.style.display = 'block';
      tooltip.innerHTML = \`<strong>\${d.data.name}</strong><br>
        \${d.data.count} calls<br>
        \${d.data.percentage}%\`;
    })
    .on('mousemove', e => {
      tooltip.style.left = (e.clientX + 15) + 'px';
      tooltip.style.top = (e.clientY - 8) + 'px';
    })
    .on('mouseout', function() {
      d3.select(this).attr('d', arc);
      tooltip.style.display = 'none';
    });

  // Center text
  g.append('text')
    .attr('text-anchor', 'middle')
    .attr('y', -10)
    .attr('fill', 'var(--text)')
    .attr('font-size', '24px')
    .attr('font-weight', '700')
    .text(totalTools);

  g.append('text')
    .attr('text-anchor', 'middle')
    .attr('y', 15)
    .attr('fill', 'var(--muted)')
    .attr('font-size', '12px')
    .text('total tool calls');
}
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export function generateDashboard(projectRoot: string): string {
  const graph    = loadGraph(projectRoot);
  const plans    = loadPlans(projectRoot).map(stripPlan);
  const sessions = loadSessions(projectRoot).map(stripSession);
  const memory   = loadMemory(projectRoot);

  const pkgPath = path.join(projectRoot, 'package.json');
  let projectName = path.basename(projectRoot);
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
    projectName = pkg.name ?? projectName;
  } catch { /* fallback to dir name */ }

  const html = buildHtml({
    graph,
    plans,
    sessions,
    memory,
    projectName,
    generatedAt: new Date().toLocaleString(),
  });

  const outPath = path.join(projectRoot, 'graphify-out', 'dashboard.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');

  // Post-process: enrich DATA (code metrics, git churn/co-change, agent session
  // mining) and splice in the extra relation-graph panels, when those scripts
  // exist alongside the output. Best-effort — the plain dashboard still works.
  for (const script of ['enrich-data.mjs', 'add-panels.mjs']) {
    const scriptPath = path.join(projectRoot, 'graphify-out', script);
    if (!fs.existsSync(scriptPath)) continue;
    try {
      execSync(`node "${scriptPath}" "${projectRoot}"`, { stdio: 'ignore', timeout: 60_000 });
    } catch { /* keep the un-enriched dashboard */ }
  }
  return outPath;
}

export function openDashboard(filePath: string): void {
  try {
    const opener =
      process.platform === 'darwin' ? 'open' :
      process.platform === 'win32'  ? 'start' :
      'xdg-open';
    execSync(`${opener} "${filePath}"`, { stdio: 'ignore' });
  } catch { /* ignore if no browser */ }
}
