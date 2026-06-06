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

function loadPlans(): ExecutionPlan[] {
  const dir = path.join(process.env.HOME ?? '/tmp', '.rubycode', 'plans');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ExecutionPlan; }
      catch { return null; }
    })
    .filter((p): p is ExecutionPlan => p !== null)
    .sort((a, b) => b.created - a.created);
}

function loadSessions(projectRoot: string): ChatSession[] {
  const safe = projectRoot.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const dir = path.join(process.env.HOME ?? '/tmp', '.rubycode', 'sessions', safe);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map(f => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Partial<ChatSession>;
        if (!parsed.id) return null;
        return parsed as ChatSession;
      } catch { return null; }
    })
    .filter((s): s is ChatSession => s !== null)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function loadMemory(projectRoot: string): object[] {
  const p = path.join(projectRoot, '.rubycode', 'memory.json');
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML template
// ─────────────────────────────────────────────────────────────────────────────

function buildHtml(data: {
  graph: object | null;
  plans: ExecutionPlan[];
  sessions: ChatSession[];
  memory: object[];
  projectName: string;
  generatedAt: string;
}): string {
  const json = JSON.stringify(data, null, 0);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ruby-code · Memory Dashboard · ${data.projectName}</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
  :root {
    --bg:      #110d06;
    --surface: #1e1509;
    --card:    #261b0d;
    --border:  #3a2a18;
    --primary: #cc785c;
    --secondary:#8a7768;
    --text:    #ede0cc;
    --muted:   #6b5645;
    --success: #5a9e6e;
    --error:   #b15439;
    --amber:   #cc9e5c;
    --blue:    #7a9ecc;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 13px; min-height: 100vh; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 24px; display: flex; align-items: center; gap: 16px; }
  header h1 { color: var(--primary); font-size: 15px; font-weight: 700; letter-spacing: 0.04em; }
  header .meta { color: var(--muted); font-size: 11px; }
  nav { background: var(--surface); border-bottom: 1px solid var(--border); display: flex; gap: 0; }
  nav button { background: none; border: none; border-bottom: 2px solid transparent; color: var(--secondary); cursor: pointer; font: inherit; font-size: 12px; padding: 10px 20px; transition: all .15s; }
  nav button:hover { color: var(--text); }
  nav button.active { border-bottom-color: var(--primary); color: var(--primary); }
  .panel { display: none; padding: 20px; height: calc(100vh - 88px); overflow: auto; }
  .panel.active { display: flex; flex-direction: column; gap: 16px; }

  /* Overview */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 16px 20px; }
  .stat-card .num { color: var(--primary); font-size: 28px; font-weight: 700; }
  .stat-card .label { color: var(--muted); font-size: 11px; margin-top: 4px; text-transform: uppercase; letter-spacing: .06em; }

  /* Graph */
  #graph-svg { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; flex: 1; min-height: 0; }
  .graph-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .graph-controls input { background: var(--card); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font: inherit; font-size: 12px; padding: 6px 10px; width: 200px; }
  .graph-controls input:focus { border-color: var(--primary); outline: none; }
  .type-filter { display: flex; gap: 6px; flex-wrap: wrap; }
  .type-pill { background: var(--card); border: 1px solid var(--border); border-radius: 12px; color: var(--secondary); cursor: pointer; font-size: 11px; padding: 3px 10px; user-select: none; }
  .type-pill.on { border-color: currentColor; }
  .tooltip { position: fixed; background: #1a1209ee; border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-size: 11px; max-width: 280px; padding: 8px 12px; pointer-events: none; z-index: 999; }
  .tooltip strong { color: var(--primary); }

  /* Sessions */
  .session-list { display: flex; flex-direction: column; gap: 8px; }
  .session-card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; padding: 12px 16px; transition: border-color .15s; }
  .session-card:hover { border-color: var(--primary); }
  .session-card .s-header { display: flex; justify-content: space-between; align-items: baseline; }
  .session-card .s-title { color: var(--primary); font-size: 13px; }
  .session-card .s-meta { color: var(--muted); font-size: 11px; }
  .session-messages { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 10px; display: none; }
  .session-card.expanded .session-messages { display: block; }
  .msg { display: flex; gap: 8px; margin-bottom: 8px; }
  .msg-role { color: var(--muted); font-size: 10px; min-width: 60px; padding-top: 1px; text-align: right; text-transform: uppercase; }
  .msg-role.user { color: var(--amber); }
  .msg-role.assistant { color: var(--blue); }
  .msg-content { color: var(--secondary); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; }

  /* Plans */
  .plans-layout { display: flex; gap: 16px; flex: 1; min-height: 0; }
  .plan-list-panel { display: flex; flex-direction: column; gap: 8px; min-width: 280px; overflow-y: auto; }
  .plan-detail { flex: 1; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .plan-card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; padding: 10px 14px; transition: border-color .15s; }
  .plan-card:hover { border-color: var(--primary); }
  .plan-card.selected { border-color: var(--primary); }
  .plan-card .p-goal { color: var(--text); font-size: 12px; }
  .plan-card .p-meta { color: var(--muted); font-size: 10px; margin-top: 4px; }
  .status-badge { border-radius: 10px; font-size: 10px; padding: 2px 7px; display: inline-block; }
  .status-done    { background: #1a3d28; color: var(--success); }
  .status-failed  { background: #3d1a10; color: var(--error); }
  .status-running { background: #2a2010; color: var(--amber); }
  .status-pending { background: #1a1a2a; color: var(--blue); }
  .status-aborted { background: #2a1a2a; color: var(--secondary); }
  #dag-svg { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; flex: 1; min-height: 0; }
  .step-result { background: var(--card); border: 1px solid var(--border); border-radius: 6px; font-size: 11px; line-height: 1.5; max-height: 200px; overflow-y: auto; padding: 12px; white-space: pre-wrap; word-break: break-word; }

  /* Memory */
  .memory-table { border-collapse: collapse; width: 100%; }
  .memory-table th { background: var(--card); border-bottom: 2px solid var(--border); color: var(--muted); font-size: 10px; letter-spacing: .06em; padding: 8px 12px; text-align: left; text-transform: uppercase; }
  .memory-table td { border-bottom: 1px solid var(--border); color: var(--secondary); font-size: 11px; padding: 7px 12px; vertical-align: top; }
  .memory-table td:first-child { color: var(--primary); white-space: nowrap; }
  .memory-table tr:hover td { background: var(--card); }
  .memory-val { max-width: 600px; white-space: pre-wrap; word-break: break-word; }

  .empty { color: var(--muted); font-size: 12px; padding: 20px; text-align: center; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--surface); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
</style>
</head>
<body>
<header>
  <h1>⬡ ruby-code memory dashboard</h1>
  <span class="meta">project: <strong style="color:var(--primary)">${data.projectName}</strong> &nbsp;·&nbsp; generated ${data.generatedAt}</span>
</header>
<nav>
  <button class="active" onclick="showPanel('overview')">Overview</button>
  <button onclick="showPanel('graph')">Codebase Graph</button>
  <button onclick="showPanel('sessions')">Sessions</button>
  <button onclick="showPanel('plans')">Execution Plans</button>
  <button onclick="showPanel('memory')">Agent Memory</button>
</nav>

<div id="overview" class="panel active"></div>
<div id="graph"    class="panel"></div>
<div id="sessions" class="panel"></div>
<div id="plans"    class="panel"></div>
<div id="memory"   class="panel"></div>

<div class="tooltip" id="tooltip" style="display:none"></div>

<script>
const DATA = ${json};

// ── Tab switching ─────────────────────────────────────────────────────────────
function showPanel(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelectorAll('nav button').forEach(b => {
    if (b.textContent.toLowerCase().replace(/\\s+/g,'').includes(id.slice(0,4))) b.classList.add('active');
  });
  if (id === 'graph' && !graphInit) initGraph();
  if (id === 'plans' && !plansInit) initPlans();
}

// ── Overview ──────────────────────────────────────────────────────────────────
(function() {
  const g = DATA.graph;
  const nodeCount = g ? g.nodes.length : 0;
  const edgeCount = g ? g.edges.length : 0;
  const sessionCount = DATA.sessions.length;
  const planCount = DATA.plans.length;
  const memCount = DATA.memory.length;
  const donePlans = DATA.plans.filter(p => p.status === 'done').length;
  const lastActive = DATA.sessions.length
    ? new Date(DATA.sessions[0].updatedAt).toLocaleString()
    : (DATA.plans.length ? new Date(DATA.plans[0].created).toLocaleString() : '—');

  const types = g ? g.nodes.reduce((a,n) => { a[n.type||'node'] = (a[n.type||'node']||0)+1; return a; }, {}) : {};
  const topTypes = Object.entries(types).sort((a,b) => b[1]-a[1]).slice(0,6)
    .map(([t,c]) => \`<span style="color:var(--primary)">\${c}</span> <span style="color:var(--muted)">\${t}s</span>\`).join(' · ');

  document.getElementById('overview').innerHTML = \`
    <div class="stats-grid">
      <div class="stat-card"><div class="num">\${nodeCount}</div><div class="label">Graph Nodes</div></div>
      <div class="stat-card"><div class="num">\${edgeCount}</div><div class="label">Graph Edges</div></div>
      <div class="stat-card"><div class="num">\${sessionCount}</div><div class="label">Chat Sessions</div></div>
      <div class="stat-card"><div class="num">\${planCount}</div><div class="label">Execution Plans</div></div>
      <div class="stat-card"><div class="num">\${donePlans}</div><div class="label">Plans Completed</div></div>
      <div class="stat-card"><div class="num">\${memCount}</div><div class="label">Memory Entries</div></div>
    </div>
    <div class="stat-card" style="max-width:600px">
      <div class="label" style="margin-bottom:8px">Codebase Breakdown</div>
      <div>\${topTypes || '<span style="color:var(--muted)">no graph data</span>'}</div>
    </div>
    <div class="stat-card" style="max-width:400px">
      <div class="label" style="margin-bottom:4px">Last Activity</div>
      <div style="color:var(--primary)">\${lastActive}</div>
    </div>
  \`;
})();

// ── Codebase Graph ────────────────────────────────────────────────────────────
let graphInit = false;
function initGraph() {
  graphInit = true;
  const panel = document.getElementById('graph');
  if (!DATA.graph || !DATA.graph.nodes.length) {
    panel.innerHTML = '<div class="empty">No graph.json found. Run :graph refresh in the REPL.</div>';
    return;
  }

  const NODE_COLORS = {
    file: '#4e3d30', function: '#cc785c', class: '#7a9ecc',
    interface: '#5a9e6e', const: '#cc9e5c', type: '#8a7768', enum: '#b15439',
  };

  const allTypes = [...new Set(DATA.graph.nodes.map(n => n.type || 'node'))];
  const activeTypes = new Set(allTypes);

  panel.innerHTML = \`
    <div class="graph-controls">
      <input id="graph-search" placeholder="Search nodes…" oninput="filterGraph()">
      <div class="type-filter" id="type-filter"></div>
    </div>
    <svg id="graph-svg"></svg>
  \`;

  const filterDiv = document.getElementById('type-filter');
  allTypes.forEach(t => {
    const pill = document.createElement('span');
    pill.className = 'type-pill on';
    pill.style.color = NODE_COLORS[t] || '#8a7768';
    pill.textContent = t;
    pill.onclick = () => {
      if (activeTypes.has(t)) { activeTypes.delete(t); pill.classList.remove('on'); }
      else { activeTypes.add(t); pill.classList.add('on'); }
      filterGraph();
    };
    filterDiv.appendChild(pill);
  });

  const svg = d3.select('#graph-svg');
  const rect = document.getElementById('graph-svg').getBoundingClientRect();
  const W = rect.width || 900, H = rect.height || 600;
  svg.attr('width', W).attr('height', H);

  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.1, 4]).on('zoom', e => g.attr('transform', e.transform)));

  svg.append('defs').append('marker')
    .attr('id','arrow').attr('viewBox','0 -4 8 8').attr('refX',16).attr('refY',0)
    .attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto')
    .append('path').attr('d','M0,-4L8,0L0,4').attr('fill','#3a2a18');

  let nodes = DATA.graph.nodes.map(n => ({...n}));
  let edges = DATA.graph.edges.map(e => ({...e}));
  let searchTerm = '';

  const tooltip = document.getElementById('tooltip');

  function filterGraph() {
    searchTerm = document.getElementById('graph-search').value.toLowerCase();
    const visibleIds = new Set(
      nodes.filter(n =>
        activeTypes.has(n.type || 'node') &&
        (!searchTerm || n.label.toLowerCase().includes(searchTerm) || (n.file||'').toLowerCase().includes(searchTerm))
      ).map(n => n.id)
    );
    g.selectAll('.node').style('opacity', d => visibleIds.has(d.id) ? 1 : 0.07);
    g.selectAll('.link').style('opacity', d => visibleIds.has(d.source.id||d.source) && visibleIds.has(d.target.id||d.target) ? 0.4 : 0.03);
  }

  window.filterGraph = filterGraph;

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(55).strength(0.5))
    .force('charge', d3.forceManyBody().strength(-120))
    .force('center', d3.forceCenter(W/2, H/2))
    .force('collision', d3.forceCollide(14));

  const link = g.append('g').selectAll('.link').data(edges).enter().append('line')
    .attr('class','link').attr('stroke','#3a2a18').attr('stroke-width',1).attr('opacity',0.4)
    .attr('marker-end','url(#arrow)');

  const node = g.append('g').selectAll('.node').data(nodes).enter().append('circle')
    .attr('class','node').attr('r', d => d.type === 'file' ? 7 : 5)
    .attr('fill', d => NODE_COLORS[d.type||'node'] || '#8a7768')
    .attr('stroke', '#1e1509').attr('stroke-width', 1.5)
    .call(d3.drag()
      .on('start', (e,d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
      .on('drag',  (e,d) => { d.fx=e.x; d.fy=e.y; })
      .on('end',   (e,d) => { if (!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; }))
    .on('mouseover', (e,d) => {
      tooltip.style.display = 'block';
      tooltip.innerHTML = \`<strong>\${d.label}</strong><br><span style="color:var(--muted)">\${d.type||'node'}</span>\${d.file ? \`<br>\${d.file}\` : ''}\${d.source_location ? \` · \${d.source_location}\` : ''}\`;
    })
    .on('mousemove', e => {
      tooltip.style.left = (e.clientX+14)+'px';
      tooltip.style.top  = (e.clientY-6)+'px';
    })
    .on('mouseout', () => { tooltip.style.display='none'; });

  const label = g.append('g').selectAll('.label').data(nodes.filter(n => n.type === 'file' || n.type === 'class' || n.type === 'interface')).enter()
    .append('text').attr('class','label').text(d => d.label.length > 18 ? d.label.slice(0,16)+'..' : d.label)
    .attr('fill','#8a7768').attr('font-size','9px').attr('pointer-events','none')
    .attr('dx', 8).attr('dy', 3);

  sim.on('tick', () => {
    link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
        .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    node.attr('cx',d=>d.x).attr('cy',d=>d.y);
    label.attr('x',d=>d.x).attr('y',d=>d.y);
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
    const turns = Math.floor(s.history.length / 2);
    const updated = new Date(s.updatedAt).toLocaleString();
    const msgs = s.history.slice(0, 20).map(m => {
      const role = m.role;
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return \`<div class="msg"><span class="msg-role \${role}">\${role}</span><div class="msg-content">\${content.slice(0,400).replace(/</g,'&lt;')}\${content.length>400?'…':''}</div></div>\`;
    }).join('');
    return \`<div class="session-card" onclick="toggleSession(this)">
      <div class="s-header">
        <span class="s-title">\${s.title.replace(/</g,'&lt;')}</span>
        <span class="s-meta">\${turns} turn\${turns!==1?'s':''} · \${updated}</span>
      </div>
      <div class="s-meta" style="margin-top:4px;font-size:10px">\${s.id}</div>
      <div class="session-messages">\${msgs}</div>
    </div>\`;
  }).join('');
  panel.innerHTML = \`<div class="session-list">\${html}</div>\`;
})();

window.toggleSession = function(el) { el.classList.toggle('expanded'); };

// ── Execution Plans ───────────────────────────────────────────────────────────
let plansInit = false;
let dagSim = null;
function initPlans() {
  plansInit = true;
  const panel = document.getElementById('plans');
  if (!DATA.plans.length) {
    panel.innerHTML = '<div class="empty">No execution plans found. Run a multi-step task first.</div>';
    return;
  }

  panel.innerHTML = \`
    <div class="plans-layout">
      <div class="plan-list-panel" id="plan-list"></div>
      <div class="plan-detail" id="plan-detail">
        <div class="empty">Select a plan to view its DAG.</div>
      </div>
    </div>
  \`;

  const listEl = document.getElementById('plan-list');
  DATA.plans.forEach((plan, i) => {
    const card = document.createElement('div');
    card.className = 'plan-card' + (i===0?' selected':'');
    const created = new Date(plan.created).toLocaleString();
    const dur = plan.completed ? Math.round((plan.completed - plan.created)/1000) + 's' : '—';
    card.innerHTML = \`
      <div class="p-goal">\${plan.goal.slice(0,80).replace(/</g,'&lt;')}\${plan.goal.length>80?'…':''}</div>
      <div class="p-meta">
        <span class="status-badge status-\${plan.status}">\${plan.status}</span>
        &nbsp;\${plan.steps.length} steps · \${dur} · \${created}
      </div>
    \`;
    card.onclick = () => {
      document.querySelectorAll('.plan-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      renderDag(plan);
    };
    listEl.appendChild(card);
  });

  if (DATA.plans.length) renderDag(DATA.plans[0]);
}

function renderDag(plan) {
  const SPEC_COLORS = { researcher:'#5a9e6e', coder:'#cc785c', reviewer:'#7a9ecc', planner:'#cc9e5c' };
  const STATUS_OPACITY = { done:1, failed:0.9, skipped:0.35, running:1, waiting:0.5 };

  const detail = document.getElementById('plan-detail');
  const outcome = plan.outcome ? \`<div class="step-result">\${plan.outcome.replace(/</g,'&lt;')}</div>\` : '';
  detail.innerHTML = \`
    <div style="display:flex;align-items:baseline;gap:12px">
      <span style="color:var(--primary);font-size:13px">\${plan.goal.replace(/</g,'&lt;')}</span>
      <span class="status-badge status-\${plan.status}">\${plan.status}</span>
    </div>
    \${outcome}
    <svg id="dag-svg"></svg>
  \`;

  const steps = plan.steps;
  const nodeData = steps.map(s => ({ ...s }));
  const edgeData = [];
  steps.forEach(s => {
    s.dependsOn.forEach(dep => edgeData.push({ source: dep, target: s.id }));
  });

  const svg = d3.select('#dag-svg');
  const rect = document.getElementById('dag-svg').getBoundingClientRect();
  const W = rect.width || 600, H = Math.max(rect.height || 300, 300);
  svg.attr('width', W).attr('height', H).selectAll('*').remove();

  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.3,3]).on('zoom', e => g.attr('transform', e.transform)));

  svg.append('defs').append('marker')
    .attr('id','dag-arrow').attr('viewBox','0 -4 8 8').attr('refX',28).attr('refY',0)
    .attr('markerWidth',8).attr('markerHeight',8).attr('orient','auto')
    .append('path').attr('d','M0,-4L8,0L0,4').attr('fill','#3a2a18');

  if (dagSim) dagSim.stop();
  dagSim = d3.forceSimulation(nodeData)
    .force('link', d3.forceLink(edgeData).id(d=>d.id).distance(120).strength(1))
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(W/2, H/2))
    .force('y', d3.forceY().strength(0.1));

  const link = g.append('g').selectAll('.dlink').data(edgeData).enter().append('line')
    .attr('class','dlink').attr('stroke','#3a2a18').attr('stroke-width',1.5)
    .attr('marker-end','url(#dag-arrow)');

  const nodeG = g.append('g').selectAll('.dnode').data(nodeData).enter().append('g')
    .attr('class','dnode').style('cursor','pointer')
    .call(d3.drag()
      .on('start',(e,d)=>{if(!e.active)dagSim.alphaTarget(0.3).restart();d.fx=d.x;d.fy=d.y;})
      .on('drag', (e,d)=>{d.fx=e.x;d.fy=e.y;})
      .on('end',  (e,d)=>{if(!e.active)dagSim.alphaTarget(0);d.fx=null;d.fy=null;}));

  nodeG.append('rect').attr('width',120).attr('height',48).attr('rx',6)
    .attr('x',-60).attr('y',-24)
    .attr('fill', d => SPEC_COLORS[d.specialist] || '#8a7768')
    .attr('fill-opacity', d => STATUS_OPACITY[d.status] || 0.5)
    .attr('stroke','#1e1509').attr('stroke-width',1.5);

  nodeG.append('text').text(d => d.specialist).attr('text-anchor','middle').attr('y',-8)
    .attr('fill','#110d06').attr('font-size','10px').attr('font-weight','700')
    .attr('font-family','monospace');

  nodeG.append('text').text(d => d.id).attr('text-anchor','middle').attr('y',6)
    .attr('fill','#110d06bb').attr('font-size','9px').attr('font-family','monospace');

  nodeG.append('text').text(d => d.status === 'done' ? '✓' : d.status === 'failed' ? '✗' : d.status === 'skipped' ? '—' : '⋯')
    .attr('text-anchor','middle').attr('y',18)
    .attr('fill','#110d06cc').attr('font-size','9px');

  const tooltip = document.getElementById('tooltip');
  nodeG.on('mouseover', (e,d) => {
    tooltip.style.display='block';
    tooltip.innerHTML = \`<strong>\${d.id}</strong> [<span style="color:var(--amber)">\${d.specialist}</span>]<br><span style="color:var(--secondary)">\${d.task.slice(0,120).replace(/</g,'&lt;')}</span>\${d.result ? \`<br><br><span style="color:var(--muted)">\${d.result.slice(0,200).replace(/</g,'&lt;')}…</span>\` : ''}\`;
  }).on('mousemove', e => {
    tooltip.style.left=(e.clientX+14)+'px'; tooltip.style.top=(e.clientY-6)+'px';
  }).on('mouseout', () => tooltip.style.display='none');

  dagSim.on('tick', () => {
    link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
        .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    nodeG.attr('transform',d=>\`translate(\${d.x},\${d.y})\`);
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
    const val = typeof m.value === 'string' ? m.value : JSON.stringify(m.value);
    return \`<tr>
      <td>\${(m.key||'').replace(/</g,'&lt;')}</td>
      <td>\${(m.stepId||'').replace(/</g,'&lt;')}</td>
      <td style="color:var(--muted)">\${ts}</td>
      <td class="memory-val">\${val.slice(0,300).replace(/</g,'&lt;')}\${val.length>300?'…':''}</td>
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
  const plans    = loadPlans();
  const sessions = loadSessions(projectRoot);
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
