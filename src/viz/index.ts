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
</nav>

<div id="overview" class="panel active"></div>
<div id="graph"    class="panel"></div>
<div id="sessions" class="panel"></div>
<div id="plans"    class="panel"></div>
<div id="memory"   class="panel"></div>

<div class="tooltip" id="tooltip" style="display:none"></div>

<script>
const DATA = ` + json + `;

function showPanel(id, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (btn) btn.classList.add('active');
  if (id === 'graph'   && !graphInit) initGraph();
  if (id === 'plans'   && !plansInit) initPlans();
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
    function:  '#ff7b72',
    class:     '#d2a8ff',
    interface: '#3fb950',
    const:     '#ffa657',
    type:      '#79c0ff',
    enum:      '#f85149',
    node:      '#8b949e',
  };
  const NODE_R = { file: 13, class: 11, interface: 10, function: 8, const: 7, type: 7, enum: 8, node: 7 };

  const allTypes = [...new Set(DATA.graph.nodes.map(n => n.type || 'node'))];
  const activeTypes = new Set(allTypes);

  panel.innerHTML = \`
    <div class="graph-controls">
      <input id="graph-search" placeholder="🔍  Search nodes, files…" oninput="filterGraph()">
      <div class="legend" id="legend"></div>
      <span class="hint">scroll to zoom · drag to pan · drag nodes</span>
    </div>
    <svg id="graph-svg"></svg>
  \`;

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

  const svgEl = document.getElementById('graph-svg');
  const W = svgEl.clientWidth || 900, H = svgEl.clientHeight || 580;
  const svg = d3.select('#graph-svg').attr('width', W).attr('height', H);
  const g = svg.append('g');

  svg.call(d3.zoom().scaleExtent([0.05, 6]).on('zoom', e => g.attr('transform', e.transform)));

  // Arrow marker — bright color
  svg.append('defs').append('marker')
    .attr('id','arr').attr('viewBox','0 -5 10 10').attr('refX',2).attr('refY',0)
    .attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto')
    .append('path').attr('d','M0,-5L10,0L0,5').attr('fill','#484f58');

  const nodes = DATA.graph.nodes.map(n => ({...n}));
  const edges = DATA.graph.edges.map(e => ({...e}));
  const tooltip = document.getElementById('tooltip');

  // Show labels for important node types always; others on hover
  const ALWAYS_LABEL = new Set(['file','class','interface']);

  function filterGraph() {
    const term = document.getElementById('graph-search').value.toLowerCase();
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
  window.filterGraph = filterGraph;

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
