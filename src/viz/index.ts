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

import { episodeStore } from '../ruby/episode-capture.js';
import { getCompetenceReport } from '../ruby/competence.js';
import type { Episode } from '../ruby/types.js';

interface MemoryFact {
  key: string;
  namespace: string;
  value: string;
  created: string;
  updated: string;
}

/**
 * Reads the REAL memory store: `~/.aura/memory/{namespace}.json`, one flat
 * file per namespace, each `{ [key]: { value, updated, created? } }`.
 *
 * This memory store is global, not project-scoped — the `memory` tool never
 * keyed entries by project root. (The previous version of this function read
 * from a per-project-hash subdirectory that nothing in the codebase ever
 * wrote to, so this panel has always returned an empty list.)
 */
function loadMemory(): MemoryFact[] {
  const dir = path.join(process.env.HOME ?? '/tmp', '.aura', 'memory');
  if (!fs.existsSync(dir)) return [];
  const facts: MemoryFact[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
    const namespace = file.replace(/\.json$/, '');
    try {
      const store = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as
        Record<string, { value: string; updated: string; created?: string }>;
      for (const [key, entry] of Object.entries(store)) {
        if (!entry || typeof entry.value !== 'string') continue;
        facts.push({
          key,
          namespace,
          value: entry.value,
          updated: entry.updated,
          // Entries written before `created` existed fall back to `updated`
          // — the earliest timestamp we actually have for them.
          created: entry.created ?? entry.updated,
        });
      }
    } catch { /* skip an unreadable/corrupt namespace file */ }
  }
  return facts.sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());
}

/**
 * Synchronous episode reader. Mirrors `episodeStore.loadEpisodes()` exactly
 * (same directory via the store's own `projectDir()`, same "never throws,
 * skip bad files" behaviour) but stays sync — `generateDashboard` must
 * remain sync, since existing tests call it without `await`.
 */
function loadEpisodesSync(projectRoot: string): Episode[] {
  try {
    const dir = episodeStore.projectDir(projectRoot);
    if (!fs.existsSync(dir)) return [];
    const episodes: Episode[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (parsed && typeof parsed.timestamp === 'number') episodes.push(parsed as Episode);
      } catch { /* skip a corrupt episode file */ }
    }
    return episodes.sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

/** Day-bucketed cumulative growth of remembered facts, by first-created date. */
function buildMemoryGrowth(facts: MemoryFact[]): { date: string; cumulative: number }[] {
  const byDay = new Map<string, number>();
  for (const f of facts) {
    const day = (f.created || '').slice(0, 10);
    if (!day) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const days = Array.from(byDay.keys()).sort();
  let running = 0;
  return days.map(date => {
    running += byDay.get(date)!;
    return { date, cumulative: running };
  });
}

/**
 * Day-bucketed learning curve: cumulative episode count, plus a rolling
 * Ruby (small-model) success rate over the last `windowSize` attempted
 * episodes up to and including each day. This is the actual "is it getting
 * better at routing to the small model" signal — competence.ts itself
 * doesn't persist a timeline, it recomputes fresh from episodes each call,
 * so this reconstructs the trend from each episode's own timestamp.
 */
function buildLearningSeries(
  episodes: Episode[],
  windowSize = 10,
): { date: string; cumulativeEpisodes: number; rollingSuccessRate: number }[] {
  const byDay = new Map<string, Episode[]>();
  for (const ep of episodes) {
    const day = new Date(ep.timestamp).toISOString().slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(ep);
    byDay.set(day, arr);
  }
  const days = Array.from(byDay.keys()).sort();
  let cumulative = 0;
  const seenSoFar: Episode[] = [];
  return days.map(date => {
    const todays = byDay.get(date)!;
    cumulative += todays.length;
    seenSoFar.push(...todays);
    const attempted = seenSoFar.filter(e => e.rubyAttempted);
    const recent = attempted.slice(-windowSize);
    const rollingSuccessRate = recent.length === 0
      ? 0
      : recent.filter(e => e.rubySucceeded).length / recent.length;
    return { date, cumulativeEpisodes: cumulative, rollingSuccessRate };
  });
}

/** Plain-data summary mirroring formatStats()'s definitions, for stat cards. */
function summariseEpisodes(episodes: Episode[]) {
  const total = episodes.length;
  const completed = episodes.filter(e => e.reviewerApproved).length;
  const avgDurationMs = total === 0
    ? 0
    : episodes.reduce((s, e) => s + (e.durationMs ?? 0), 0) / total;
  const totalTokens = episodes.reduce(
    (s, e) => s + (e.tokensUsed?.ruby ?? 0) + (e.tokensUsed?.largeModel ?? 0),
    0,
  );
  const rubyAttempted = episodes.filter(e => e.rubyAttempted);
  const rubySuccessRate = rubyAttempted.length === 0
    ? 0
    : rubyAttempted.filter(e => e.rubySucceeded).length / rubyAttempted.length;

  const modelCounts = new Map<string, number>();
  for (const e of episodes) {
    const model = e.largeModelUsed ?? (e.rubySucceeded ? 'ruby (small model)' : undefined);
    if (model) modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
  }
  const topModels = Array.from(modelCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([model, count]) => ({ model, count }));

  return { total, completed, avgDurationMs, totalTokens, rubySuccessRate, topModels };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML template
// ─────────────────────────────────────────────────────────────────────────────

function buildHtml(data: {
  graph: object | null;
  plans: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  memory: MemoryFact[];
  memoryGrowth: { date: string; cumulative: number }[];
  episodeSummary: ReturnType<typeof summariseEpisodes>;
  learningSeries: { date: string; cumulativeEpisodes: number; rollingSuccessRate: number }[];
  competenceReport: { category: string; successRate: number; count: number }[];
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
<script src="https://unpkg.com/three@0.147.0/build/three.min.js"></script>
<script src="https://unpkg.com/three@0.147.0/examples/js/controls/OrbitControls.js"></script>
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
  #graph-3d-wrap { background: var(--canvas); border: 1px solid var(--border); border-radius: 8px; flex: 1; min-height: 0; position: relative; overflow: hidden; display: none; }
  #graph-3d-wrap canvas { display: block; width: 100%; height: 100%; }
  .graph-3d-hint { position: absolute; bottom: 10px; right: 14px; color: var(--dim); font-size: 10px; pointer-events: none; z-index: 2; }
  .graph-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .layout-toggle { display: flex; gap: 4px; }
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
  .ns-badge { background: var(--canvas); border: 1px solid var(--border2); border-radius: 10px; color: var(--blue); font-size: 10px; padding: 1px 8px; white-space: nowrap; }

  /* Line charts (memory growth, learning curve) */
  .chart-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; }
  .chart-card .lbl { color: var(--muted); font-size: 10px; margin-bottom: 10px; text-transform: uppercase; letter-spacing: .08em; }
  .chart-svg { width: 100%; height: 220px; overflow: visible; }
  .chart-line { fill: none; stroke-width: 2; }
  .chart-area { opacity: .12; }
  .chart-dot { stroke: var(--bg); stroke-width: 1.5; }
  .chart-axis text { fill: var(--dim); font-size: 9px; font-family: inherit; }
  .chart-axis path, .chart-axis line { stroke: var(--border); }
  .chart-empty { align-items: center; color: var(--dim); display: flex; font-size: 11px; height: 220px; justify-content: center; }

  /* 3D bar charts (true.js cylinders) + their HTML legends */
  .chart-3d-container { height: 260px; position: relative; width: 100%; }
  .chart-3d-container canvas { display: block; height: 100%; width: 100%; }
  .legend-3d { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 10px; }
  .legend-3d-row { align-items: center; display: flex; gap: 7px; }
  .legend-3d-dot { border-radius: 50%; flex-shrink: 0; height: 10px; width: 10px; }
  .legend-3d-name { color: var(--text); font-size: 11px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legend-3d-val { color: var(--muted); font-size: 10px; }
  .two-col { display: grid; gap: 14px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }

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
  <button onclick="showPanel('memory',this)">Memory Growth</button>
  <button onclick="showPanel('learning',this)">Learning</button>
</nav>

<div id="overview" class="panel active"></div>
<div id="graph"    class="panel"></div>
<div id="sessions" class="panel"></div>
<div id="plans"    class="panel"></div>
<div id="memory"   class="panel"></div>
<div id="learning" class="panel"></div>

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
  if (id === 'memory'   && !memoryInit) initMemoryCharts();
  if (id === 'learning' && !learningInit) initLearningCharts();
}

// ── Overview ─────────────────────────────────────────────────────────────────
(function() {
  const g = DATA.graph;
  const nc = g ? g.nodes.length : 0, ec = g ? g.edges.length : 0;
  const sc = DATA.sessions.length, pc = DATA.plans.length;
  const mc = DATA.memory.length, dc = DATA.plans.filter(p=>p.status==='done').length;
  const epc = DATA.episodeSummary.total;
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
      <div class="stat-card"><div class="num">\${epc}</div><div class="lbl">Episodes Recorded</div></div>
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
    concept:    '#e3b341',
    decision:   '#bc8cff',
    constraint: '#56d4dd',
    node:      '#8b949e',
  };
  const NODE_R = { file: 13, class: 11, interface: 10, function: 8, const: 7, type: 7, enum: 8, concept: 9, decision: 9, constraint: 9, node: 7 };

  const allTypes = [...new Set(DATA.graph.nodes.map(n => n.type || 'node'))];
  const activeTypes = new Set(allTypes);

  panel.innerHTML = \`
    <div class="graph-controls">
      <input id="graph-search" placeholder="🔍  Search nodes, files…" oninput="filterGraph()">
      <div class="layout-toggle" id="layout-toggle">
        <span class="legend-item on" id="layout-force">Force</span>
        <span class="legend-item" id="layout-radial">Radial</span>
        <span class="legend-item" id="layout-3d-spread">3D Spread</span>
        <span class="legend-item" id="layout-3d-explore">3D Explore</span>
      </div>
      <div class="legend" id="legend"></div>
      <span class="hint" id="graph-hint">scroll to zoom · drag to pan · drag nodes</span>
    </div>
    <svg id="graph-svg"></svg>
    <div id="graph-3d-wrap"><div class="graph-3d-hint" id="graph-3d-hint"></div></div>
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

  // Ring distance per node type — files innermost (the structural anchors),
  // then class/interface, then everything else outward. Same key set as
  // NODE_COLORS/NODE_R above, so every type already has a sensible color
  // and radius gets a sensible ring too.
  const RADIAL_BY_TYPE = { file: 70, class: 170, interface: 170, concept: 220, decision: 220, constraint: 220, const: 260, type: 260, enum: 260, function: 320, node: 320 };
  const radiusFor = d => RADIAL_BY_TYPE[d.type || 'node'] ?? 320;

  function applyLayout(mode) {
    if (mode === 'radial') {
      sim.force('center', null);
      sim.force('radial', d3.forceRadial(radiusFor, W / 2, H / 2).strength(0.9));
    } else {
      sim.force('radial', null);
      sim.force('center', d3.forceCenter(W / 2, H / 2));
    }
    sim.alpha(1).restart();
  }

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

  // ── 3D mode state ──────────────────────────────────────────────────────────
  let three3dCleanup = null;  // function to stop the 3D render loop
  let current3dMode = null;   // 'spread' | 'explore' | null

  function destroy3d() {
    if (three3dCleanup) { three3dCleanup(); three3dCleanup = null; }
    current3dMode = null;
    const wrap = document.getElementById('graph-3d-wrap');
    // Remove old canvas but keep the hint div
    const oldCanvas = wrap.querySelector('canvas');
    if (oldCanvas) oldCanvas.remove();
  }

  function show2d() {
    destroy3d();
    document.getElementById('graph-svg').style.display = '';
    document.getElementById('graph-3d-wrap').style.display = 'none';
    document.getElementById('graph-hint').textContent = 'scroll to zoom · drag to pan · drag nodes';
  }

  function show3d(mode) {
    destroy3d();
    current3dMode = mode;
    document.getElementById('graph-svg').style.display = 'none';
    const wrap = document.getElementById('graph-3d-wrap');
    wrap.style.display = 'block';
    const hintEl = document.getElementById('graph-3d-hint');
    if (mode === 'spread') {
      document.getElementById('graph-hint').textContent = 'auto-rotating 3D layout · scroll to zoom';
      hintEl.textContent = '✦ auto-rotate';
    } else {
      document.getElementById('graph-hint').textContent = 'drag to rotate · scroll to zoom · right-drag to pan';
      hintEl.textContent = '✦ orbit controls';
    }
    init3dGraph(wrap, mode);
  }

  function init3dGraph(container, mode) {
    const W = container.clientWidth || 900;
    const H = container.clientHeight || 580;

    // ── Scene setup ──────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1c2128);
    scene.fog = new THREE.FogExp2(0x1c2128, 0.0008);

    const camera = new THREE.PerspectiveCamera(55, W / H, 1, 8000);
    camera.position.set(0, 0, 600);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H);
    container.appendChild(renderer.domElement);

    // ── OrbitControls (explore mode) or auto-rotate (spread mode) ─
    let controls = null;
    if (mode === 'explore' && typeof THREE.OrbitControls !== 'undefined') {
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.rotateSpeed = 0.6;
      controls.zoomSpeed = 1.2;
      controls.minDistance = 80;
      controls.maxDistance = 3000;
    }

    // ── Zoom via scroll (spread mode — no orbit controls) ────────
    if (mode === 'spread') {
      renderer.domElement.addEventListener('wheel', e => {
        e.preventDefault();
        camera.position.z = Math.max(80, Math.min(3000, camera.position.z + e.deltaY * 0.5));
      }, { passive: false });
    }

    // ── Node data with 3D positions ──────────────────────────────
    const n3 = DATA.graph.nodes.map((n, i) => {
      // Initial sphere around origin, randomised
      const phi = Math.acos(2 * Math.random() - 1);
      const theta = Math.random() * Math.PI * 2;
      const r = 100 + Math.random() * 250;
      return {
        ...n,
        x: r * Math.sin(phi) * Math.cos(theta),
        y: r * Math.sin(phi) * Math.sin(theta),
        z: r * Math.cos(phi),
        vx: 0, vy: 0, vz: 0,
      };
    });
    const idMap = new Map(n3.map((n, i) => [n.id, i]));
    const e3 = DATA.graph.edges.map(e => ({
      si: idMap.get(typeof e.source === 'object' ? e.source.id : e.source) ?? -1,
      ti: idMap.get(typeof e.target === 'object' ? e.target.id : e.target) ?? -1,
      relation: e.relation,
    })).filter(e => e.si >= 0 && e.ti >= 0);

    // ── 3D force simulation (simple Euler integration) ──────────
    const SIM_ITERS = 200;
    const REPULSION = 800;
    const SPRING_K = 0.04;
    const SPRING_REST = 60;
    const DAMPING = 0.85;
    const CENTER_PULL = 0.001;

    for (let iter = 0; iter < SIM_ITERS; iter++) {
      // Repulsion (O(n²) — fine for < 2000 nodes)
      for (let i = 0; i < n3.length; i++) {
        for (let j = i + 1; j < n3.length; j++) {
          let dx = n3[i].x - n3[j].x, dy = n3[i].y - n3[j].y, dz = n3[i].z - n3[j].z;
          let dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
          let force = REPULSION / (dist * dist);
          let fx = dx / dist * force, fy = dy / dist * force, fz = dz / dist * force;
          n3[i].vx += fx; n3[i].vy += fy; n3[i].vz += fz;
          n3[j].vx -= fx; n3[j].vy -= fy; n3[j].vz -= fz;
        }
      }
      // Springs (edges)
      for (const e of e3) {
        const s = n3[e.si], t = n3[e.ti];
        let dx = t.x - s.x, dy = t.y - s.y, dz = t.z - s.z;
        let dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
        let force = SPRING_K * (dist - SPRING_REST);
        let fx = dx / dist * force, fy = dy / dist * force, fz = dz / dist * force;
        s.vx += fx; s.vy += fy; s.vz += fz;
        t.vx -= fx; t.vy -= fy; t.vz -= fz;
      }
      // Center pull + damping + integrate
      for (const n of n3) {
        n.vx -= n.x * CENTER_PULL;
        n.vy -= n.y * CENTER_PULL;
        n.vz -= n.z * CENTER_PULL;
        n.vx *= DAMPING; n.vy *= DAMPING; n.vz *= DAMPING;
        n.x += n.vx; n.y += n.vy; n.z += n.vz;
      }
    }

    // ── Build Three.js objects ───────────────────────────────────
    const NC = {
      file:'#58a6ff', function:'#ff7b72', class:'#d2a8ff', interface:'#3fb950',
      const:'#ffa657', type:'#79c0ff', enum:'#f85149', concept:'#e3b341',
      decision:'#bc8cff', constraint:'#56d4dd', node:'#8b949e', module:'#58a6ff',
    };
    const NR3 = { file:5, class:4.5, interface:4, function:3.5, const:3, type:3, enum:3.5, concept:3.5, decision:3.5, constraint:3.5, node:3, module:4 };

    // Nodes — glowing spheres
    const spheres = [];
    for (const n of n3) {
      const color = new THREE.Color(NC[n.type||'node'] || '#8b949e');
      const r = NR3[n.type||'node'] || 3;
      const geo = new THREE.SphereGeometry(r, 16, 12);
      const mat = new THREE.MeshBasicMaterial({ color });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(n.x, n.y, n.z);
      mesh.userData = n;
      scene.add(mesh);
      spheres.push(mesh);

      // Glow ring
      const glowGeo = new THREE.SphereGeometry(r * 1.6, 12, 8);
      const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08 });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.copy(mesh.position);
      scene.add(glow);
    }

    // Edges — lines
    const edgeLineMat = new THREE.LineBasicMaterial({ color: 0x484f58, transparent: true, opacity: 0.35 });
    for (const e of e3) {
      const s = n3[e.si], t = n3[e.ti];
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(s.x, s.y, s.z),
        new THREE.Vector3(t.x, t.y, t.z),
      ]);
      scene.add(new THREE.Line(geo, edgeLineMat));
    }

    // Labels (sprite text) — only for file / class / interface
    const LABEL_TYPES = new Set(['file','class','interface']);
    for (const n of n3) {
      if (!LABEL_TYPES.has(n.type || '')) continue;
      const label = n.label.length > 18 ? n.label.slice(0, 16) + '…' : n.label;
      const canvas2 = document.createElement('canvas');
      const ctx2 = canvas2.getContext('2d');
      canvas2.width = 256; canvas2.height = 48;
      ctx2.fillStyle = 'transparent';
      ctx2.fillRect(0, 0, 256, 48);
      ctx2.font = 'bold 22px monospace';
      ctx2.fillStyle = NC[n.type||'node'] || '#8b949e';
      ctx2.fillText(label, 4, 32);
      const tex = new THREE.CanvasTexture(canvas2);
      tex.minFilter = THREE.LinearFilter;
      const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.position.set(n.x + (NR3[n.type||'node']||3) + 6, n.y + 2, n.z);
      sprite.scale.set(48, 9, 1);
      scene.add(sprite);
    }

    // ── Raycaster for tooltips ──────────────────────────────────
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 5 };
    const mouse = new THREE.Vector2();
    const tooltip3d = document.getElementById('tooltip');
    let hoveredMesh = null;

    renderer.domElement.addEventListener('mousemove', e => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(spheres);
      if (hits.length > 0) {
        const d = hits[0].object.userData;
        tooltip3d.style.display = 'block';
        tooltip3d.innerHTML = \`<strong>\${d.label}</strong><br>
          <span class="t-type">\${d.type||'node'}</span>
          \${d.file ? \`<br><span class="t-file">\${d.file}</span>\` : ''}\`;
        tooltip3d.style.left = (e.clientX + 15) + 'px';
        tooltip3d.style.top = (e.clientY - 8) + 'px';
        if (hoveredMesh !== hits[0].object) {
          if (hoveredMesh) hoveredMesh.scale.setScalar(1);
          hoveredMesh = hits[0].object;
          hoveredMesh.scale.setScalar(1.5);
        }
      } else {
        tooltip3d.style.display = 'none';
        if (hoveredMesh) { hoveredMesh.scale.setScalar(1); hoveredMesh = null; }
      }
    });

    // ── Ambient particles for depth perception ──────────────────
    const particleCount = 200;
    const pGeo = new THREE.BufferGeometry();
    const pPos = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      pPos[i*3]   = (Math.random() - 0.5) * 1200;
      pPos[i*3+1] = (Math.random() - 0.5) * 1200;
      pPos[i*3+2] = (Math.random() - 0.5) * 1200;
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    const pMat = new THREE.PointsMaterial({ color: 0x30363d, size: 1.5, transparent: true, opacity: 0.5 });
    scene.add(new THREE.Points(pGeo, pMat));

    // ── Animate ─────────────────────────────────────────────────
    let animId = null;
    let autoAngle = 0;
    function animate() {
      animId = requestAnimationFrame(animate);

      if (mode === 'spread') {
        autoAngle += 0.003;
        camera.position.x = Math.sin(autoAngle) * camera.position.z;
        camera.position.y = Math.cos(autoAngle * 0.4) * camera.position.z * 0.3;
        const fwd = Math.cos(autoAngle) * camera.position.z;
        camera.position.z = Math.abs(fwd) < 80 ? 80 * Math.sign(fwd || 1) : fwd;
        camera.lookAt(0, 0, 0);
      }

      if (controls) controls.update();
      renderer.render(scene, camera);
    }
    animate();

    // ── Resize handler ──────────────────────────────────────────
    function onResize() {
      const w = container.clientWidth || 900;
      const h = container.clientHeight || 580;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

    // ── Cleanup function ────────────────────────────────────────
    three3dCleanup = () => {
      if (animId) cancelAnimationFrame(animId);
      window.removeEventListener('resize', onResize);
      if (controls) controls.dispose();
      renderer.dispose();
    };
  }

  const forcePill = document.getElementById('layout-force');
  const radialPill = document.getElementById('layout-radial');
  const spread3dPill = document.getElementById('layout-3d-spread');
  const explore3dPill = document.getElementById('layout-3d-explore');
  const allPills = [forcePill, radialPill, spread3dPill, explore3dPill];

  function activatePill(pill) {
    allPills.forEach(p => p.classList.remove('on'));
    pill.classList.add('on');
  }

  forcePill.onclick = () => {
    activatePill(forcePill);
    show2d();
    applyLayout('force');
  };
  radialPill.onclick = () => {
    activatePill(radialPill);
    show2d();
    applyLayout('radial');
  };
  spread3dPill.onclick = () => {
    activatePill(spread3dPill);
    show3d('spread');
  };
  explore3dPill.onclick = () => {
    activatePill(explore3dPill);
    show3d('explore');
  };
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

// ── Shared helpers ───────────────────────────────────────────────────────────
function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}
function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function fmtPct(r) { return Math.round(r * 100) + '%'; }

/** Minimal D3 line+area chart. data is an array of day-bucketed points. */
function drawLineChart(svg, data, xKey, yKey, color, fmt) {
  fmt = fmt || (v => v);
  const W = svg.clientWidth || 600, H = 220;
  const margin = { top: 10, right: 16, bottom: 24, left: 40 };
  const x = d3.scaleTime()
    .domain(d3.extent(data, d => new Date(d[xKey])))
    .range([margin.left, W - margin.right]);
  const yMax = Math.max(d3.max(data, d => d[yKey]) || 1, 0.0001);
  const y = d3.scaleLinear().domain([0, yMax * 1.15]).range([H - margin.bottom, margin.top]);

  const s = d3.select(svg).attr('viewBox', \`0 0 \${W} \${H}\`);

  s.append('g').attr('class', 'chart-axis')
    .attr('transform', \`translate(0,\${H - margin.bottom})\`)
    .call(d3.axisBottom(x).ticks(Math.min(6, data.length)).tickFormat(d3.timeFormat('%b %d')));
  s.append('g').attr('class', 'chart-axis')
    .attr('transform', \`translate(\${margin.left},0)\`)
    .call(d3.axisLeft(y).ticks(4).tickFormat(fmt));

  const line = d3.line().x(d => x(new Date(d[xKey]))).y(d => y(d[yKey])).curve(d3.curveMonotoneX);
  const area = d3.area().x(d => x(new Date(d[xKey]))).y0(H - margin.bottom).y1(d => y(d[yKey])).curve(d3.curveMonotoneX);

  s.append('path').datum(data).attr('class', 'chart-area').attr('fill', color).attr('d', area);
  s.append('path').datum(data).attr('class', 'chart-line').attr('stroke', color).attr('d', line);

  s.selectAll('.chart-dot').data(data).join('circle')
    .attr('class', 'chart-dot')
    .attr('cx', d => x(new Date(d[xKey]))).attr('cy', d => y(d[yKey])).attr('r', 3.5).attr('fill', color)
    .on('mouseover', (e, d) => {
      tooltip.style.display = 'block';
      tooltip.innerHTML = \`<strong>\${new Date(d[xKey]).toLocaleDateString()}</strong><br>\${fmt(d[yKey])}\`;
    })
    .on('mousemove', e => { tooltip.style.left = (e.clientX + 15) + 'px'; tooltip.style.top = (e.clientY - 8) + 'px'; })
    .on('mouseout', () => tooltip.style.display = 'none');
}

// ── 3D bar chart colors (shared between THREE materials and HTML legend swatches —
//    same string feeds both, so the legend always matches what's on screen) ────
function successRateColor(rate) {
  const hue = Math.round(rate * 120); // 0=red (bad) → 120=green (good)
  return 'hsl(' + hue + ',65%,50%)';
}
const MODEL_PALETTE = ['#f0883e', '#58a6ff', '#bc8cff', '#3fb950', '#d29922', '#f85149'];

function legendRow(label, value, swatch) {
  return \`<div class="legend-3d-row">
    <span class="legend-3d-dot" style="background:\${swatch}"></span>
    <span class="legend-3d-name">\${String(label).replace(/</g,'&lt;')}</span>
    <span class="legend-3d-val">\${value}</span>
  </div>\`;
}

/**
 * True rotatable 3D bar chart (cylinders) via three.js. Drag horizontally to
 * orbit; auto-rotates slowly when idle. Hover a bar for its value via
 * raycasting into the existing global tooltip div.
 *
 * 'items': [{ label, value, color }] — color is any CSS color string, used
 * directly as both the THREE.js material color and (by the caller) the
 * legend swatch, so the two can never drift out of sync.
 *
 * Must only be called once its canvas is actually visible — a hidden
 * (display:none) container has zero width, which would size the renderer
 * wrong. That's why this is invoked from the lazy init*Charts() functions
 * below, the same way the codebase graph defers initGraph() until shown.
 */
function init3DBarChart(canvas, items) {
  if (!canvas || !items.length) return;
  const container = canvas.parentElement;
  const W = container.clientWidth || 480, H = 260;
  canvas.width = W; canvas.height = H;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(W, H, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 0.95);
  key.position.set(4, 8, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.3);
  rim.position.set(-4, 2, -4);
  scene.add(rim);

  const group = new THREE.Group();
  scene.add(group);

  const maxVal = Math.max(1, ...items.map(it => it.value));
  const n = items.length;
  const spacing = 1.7;
  const totalWidth = (n - 1) * spacing;
  const meshes = [];

  items.forEach((it, i) => {
    const h = Math.max(0.2, (it.value / maxVal) * 3.2);
    const geo = new THREE.CylinderGeometry(0.55, 0.62, h, 28);
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(it.color), roughness: 0.45, metalness: 0.15 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(i * spacing - totalWidth / 2, h / 2, 0);
    mesh.userData = { label: it.label, value: it.value };
    group.add(mesh);
    meshes.push(mesh);
  });

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(totalWidth / 2 + 1.5, 48),
    new THREE.MeshStandardMaterial({ color: 0x161b22, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);

  camera.position.set(0, 3.6, totalWidth + 5.5);
  camera.lookAt(0, 1, 0);

  let rotY = 0, dragging = false, lastX = 0, autoRotate = true;
  canvas.style.cursor = 'grab';

  canvas.addEventListener('pointerdown', e => {
    dragging = true; autoRotate = false; lastX = e.clientX; canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('pointerup', () => { dragging = false; canvas.style.cursor = 'grab'; });
  window.addEventListener('pointermove', e => {
    if (dragging) { rotY += (e.clientX - lastX) * 0.008; lastX = e.clientX; }
  });

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  canvas.addEventListener('pointermove', e => {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(meshes)[0];
    if (hit) {
      tooltip.style.display = 'block';
      tooltip.innerHTML = \`<strong>\${hit.object.userData.label}</strong><br>\${hit.object.userData.value}\`;
      tooltip.style.left = (e.clientX + 15) + 'px';
      tooltip.style.top = (e.clientY - 8) + 'px';
    } else {
      tooltip.style.display = 'none';
    }
  });
  canvas.addEventListener('pointerleave', () => { tooltip.style.display = 'none'; });

  (function tick() {
    if (autoRotate) rotY += 0.0025;
    group.rotation.y = rotY;
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  })();
}

// ── Memory Growth ────────────────────────────────────────────────────────────
let memoryInit = false;
(function() {
  const panel = document.getElementById('memory');
  const facts = DATA.memory;
  const growth = DATA.memoryGrowth;
  const namespaces = new Set(facts.map(f => f.namespace)).size;
  const oldest = facts.length ? new Date(facts[0].created).toLocaleDateString() : '—';
  const newest = facts.length ? new Date(facts[facts.length-1].created).toLocaleDateString() : '—';

  const rows = [...facts].reverse().map(f => {
    const val = f.value || '';
    return \`<tr>
      <td>\${f.key.replace(/</g,'&lt;')}</td>
      <td><span class="ns-badge">\${f.namespace.replace(/</g,'&lt;')}</span></td>
      <td style="color:var(--dim);white-space:nowrap">\${new Date(f.created).toLocaleString()}</td>
      <td style="color:var(--dim);white-space:nowrap">\${new Date(f.updated).toLocaleString()}</td>
      <td class="memory-val">\${val.slice(0,400).replace(/</g,'&lt;')}\${val.length>400?'…':''}</td>
    </tr>\`;
  }).join('');

  panel.innerHTML = \`
    <div class="stats-grid">
      <div class="stat-card"><div class="num">\${facts.length}</div><div class="lbl">Facts Remembered</div></div>
      <div class="stat-card"><div class="num">\${namespaces}</div><div class="lbl">Namespaces</div></div>
      <div class="stat-card"><div class="num" style="font-size:18px">\${oldest}</div><div class="lbl">First Remembered</div></div>
      <div class="stat-card"><div class="num" style="font-size:18px">\${newest}</div><div class="lbl">Most Recent</div></div>
    </div>
    <div class="chart-card">
      <div class="lbl">Cumulative facts remembered, over time</div>
      \${growth.length ? '<svg class="chart-svg" id="mem-growth-svg"></svg>' : '<div class="chart-empty">No memory yet — facts appear here as Aura remembers things.</div>'}
    </div>
    \${facts.length ? \`<table class="memory-table">
      <thead><tr><th>Key</th><th>Namespace</th><th>Created</th><th>Updated</th><th>Value</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>\` : '<div class="empty">No memory entries found.</div>'}
  \`;
})();

/** Draws the memory-growth line chart. Called once, the first time the
 *  Memory Growth tab is actually shown (see showPanel above) — doing it at
 *  page-load time would measure a hidden, zero-width panel. */
function initMemoryCharts() {
  memoryInit = true;
  const svg = document.getElementById('mem-growth-svg');
  if (svg && DATA.memoryGrowth.length) {
    drawLineChart(svg, DATA.memoryGrowth, 'date', 'cumulative', 'var(--blue)', v => Math.round(v));
  }
}

// ── Learning ─────────────────────────────────────────────────────────────────
let learningInit = false;
(function() {
  const panel = document.getElementById('learning');
  const sum = DATA.episodeSummary;
  const series = DATA.learningSeries;
  const report = DATA.competenceReport;

  if (sum.total === 0) {
    panel.innerHTML = '<div class="empty">No episodes recorded yet — this fills in as Aura completes tasks with self-improvement enabled.</div>';
    return;
  }

  const completePct = sum.total === 0 ? 0 : sum.completed / sum.total;

  const catLegend = report.length
    ? report.map(r => legendRow(r.category, \`\${r.count} · \${fmtPct(r.successRate)}\`, successRateColor(r.successRate))).join('')
    : '<div class="empty" style="padding:14px">No Ruby-attempted episodes yet.</div>';

  const modelLegend = sum.topModels.length
    ? sum.topModels.map((m, i) => legendRow(m.model, String(m.count), MODEL_PALETTE[i % MODEL_PALETTE.length])).join('')
    : '<div class="empty" style="padding:14px">No model usage recorded yet.</div>';

  panel.innerHTML = \`
    <div class="stats-grid">
      <div class="stat-card"><div class="num">\${sum.total}</div><div class="lbl">Episodes Recorded</div></div>
      <div class="stat-card"><div class="num">\${fmtPct(completePct)}</div><div class="lbl">Tasks Completed</div></div>
      <div class="stat-card"><div class="num">\${fmtPct(sum.rubySuccessRate)}</div><div class="lbl">Ruby Success Rate</div></div>
      <div class="stat-card"><div class="num" style="font-size:20px">\${fmtDuration(sum.avgDurationMs)}</div><div class="lbl">Avg Duration</div></div>
      <div class="stat-card"><div class="num" style="font-size:20px">\${fmtTokens(sum.totalTokens)}</div><div class="lbl">Total Tokens</div></div>
    </div>
    <div class="two-col">
      <div class="chart-card">
        <div class="lbl">Cumulative episodes, over time</div>
        \${series.length ? '<svg class="chart-svg" id="ep-growth-svg"></svg>' : '<div class="chart-empty">Not enough data yet.</div>'}
      </div>
      <div class="chart-card">
        <div class="lbl">Ruby (small-model) success rate — rolling, last 10 attempts</div>
        \${series.length ? '<svg class="chart-svg" id="ep-success-svg"></svg>' : '<div class="chart-empty">Not enough data yet.</div>'}
      </div>
    </div>
    <div class="two-col">
      <div class="chart-card">
        <div class="lbl">By task category — height = volume, color = Ruby success rate. Drag to rotate.</div>
        <div class="chart-3d-container"><canvas id="cat-3d-canvas"></canvas></div>
        <div class="legend-3d">\${catLegend}</div>
      </div>
      <div class="chart-card">
        <div class="lbl">By model used — height = task count. Drag to rotate.</div>
        <div class="chart-3d-container"><canvas id="model-3d-canvas"></canvas></div>
        <div class="legend-3d">\${modelLegend}</div>
      </div>
    </div>
  \`;
})();

/** Draws the two D3 line charts and the two three.js 3D bar charts for the
 *  Learning tab. Lazy — see initMemoryCharts() for why. */
function initLearningCharts() {
  learningInit = true;
  const series = DATA.learningSeries;
  const report = DATA.competenceReport;
  const sum = DATA.episodeSummary;

  const growthSvg = document.getElementById('ep-growth-svg');
  if (growthSvg && series.length) {
    drawLineChart(growthSvg, series, 'date', 'cumulativeEpisodes', 'var(--primary)', v => Math.round(v));
  }
  const successSvg = document.getElementById('ep-success-svg');
  if (successSvg && series.length) {
    drawLineChart(successSvg, series, 'date', 'rollingSuccessRate', 'var(--success)', v => fmtPct(v));
  }

  init3DBarChart(
    document.getElementById('cat-3d-canvas'),
    report.map(r => ({ label: r.category, value: r.count, color: successRateColor(r.successRate) })),
  );
  init3DBarChart(
    document.getElementById('model-3d-canvas'),
    sum.topModels.map((m, i) => ({ label: m.model, value: m.count, color: MODEL_PALETTE[i % MODEL_PALETTE.length] })),
  );
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
  const memory   = loadMemory();
  const memoryGrowth = buildMemoryGrowth(memory);

  const episodes = loadEpisodesSync(projectRoot);
  const learningSeries = buildLearningSeries(episodes);
  const episodeSummary = summariseEpisodes(episodes);
  const competenceReport = getCompetenceReport(episodes);

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
    memoryGrowth,
    episodeSummary,
    learningSeries,
    competenceReport,
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
