// ─────────────────────────────────────────────────────────────────────────────
// Kanban Pipeline Server
// Serves the interactive board + runs the Read→Plan→Execute→Verify→Report
// pipeline via API + WebSocket progress events.
// ─────────────────────────────────────────────────────────────────────────────

import * as http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { runPipeline, getBoardTasks } from './pipeline.js';
import type { PipelineReport, ProgressEvent, KanbanTask, PipelineRow, PipelinePhase } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface KanbanServerOptions {
  port: number;
  cwd: string;
}

export async function startKanbanServer(opts: KanbanServerOptions): Promise<void> {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  app.use(express.json());

  let lastReport: PipelineReport | null = null;
  let isRunning = false;
  const progressClients = new Set<WebSocket>();

  // ── Serve the Kanban board ───────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(buildKanbanUI());
  });

  // ── API: Get all tasks ──────────────────────────────────────────────────
  app.get('/api/tasks', (_req, res) => {
    res.json(getBoardTasks());
  });

  // ── API: Execute the full pipeline ──────────────────────────────────────
  app.post('/api/execute', async (_req, res) => {
    if (isRunning) {
      res.status(409).json({ error: 'Pipeline already running' });
      return;
    }

    isRunning = true;
    const start = Date.now();

    try {
      const report = await runPipeline({
        projectRoot: opts.cwd,
        onProgress: (event: ProgressEvent) => {
          for (const ws of progressClients) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(event));
            }
          }
        },
      });

      lastReport = report;
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    } finally {
      isRunning = false;
    }
  });

  // ── API: Get last report ────────────────────────────────────────────────
  app.get('/api/report', (_req, res) => {
    if (!lastReport) {
      res.status(404).json({ error: 'No report yet. POST /api/execute first.' });
      return;
    }
    res.json(lastReport);
  });

  // ── API: Report as Markdown ─────────────────────────────────────────────
  app.get('/api/report.md', (_req, res) => {
    if (!lastReport) {
      res.status(404).send('No report yet. Run the pipeline first.');
      return;
    }
    res.setHeader('Content-Type', 'text/markdown');
    res.send(renderReportMarkdown(lastReport));
  });

  // ── WebSocket: real-time progress ───────────────────────────────────────
  wss.on('connection', (ws) => {
    progressClients.add(ws);
    ws.on('close', () => progressClients.delete(ws));
    ws.send(JSON.stringify({ type: 'connected', running: isRunning }));
  });

  // ── Start listening ─────────────────────────────────────────────────────
  server.listen(opts.port, () => {
    console.log('');
    console.log('  ◆ Aura Kanban Pipeline Server');
    console.log(`  ├─ Board:    http://localhost:${opts.port}`);
    console.log(`  ├─ API:      http://localhost:${opts.port}/api/tasks`);
    console.log(`  ├─ Execute:  POST http://localhost:${opts.port}/api/execute`);
    console.log(`  ├─ Report:   http://localhost:${opts.port}/api/report`);
    console.log(`  ├─ Report:   http://localhost:${opts.port}/api/report.md`);
    console.log(`  └─ WebSocket ws://localhost:${opts.port}`);
    console.log('');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the Kanban board HTML (enhanced version of the original)
// ─────────────────────────────────────────────────────────────────────────────

function buildKanbanUI(): string {
  const tasks = getBoardTasks();

  // Organize tasks into a grid: row × phase
  const grid = new Map<string, KanbanTask[]>();
  for (const t of tasks) {
    const key = `${t.row}|${t.phase}`;
    const arr = grid.get(key) ?? [];
    arr.push(t);
    grid.set(key, arr);
  }

  const ROWS: Array<{ id: PipelineRow; label: string; sub: string }> = [
    { id: 'orchestrate', label: 'Orchestrate', sub: 'Multi-Agent' },
    { id: 'architect', label: 'Architect', sub: 'Design Phase' },
    { id: 'verify', label: 'Verify', sub: 'Self-Correction' },
    { id: 'ruby-alternator', label: 'RubyAlternator', sub: 'Improvement' },
  ];

  const PHASES: Array<{ id: PipelinePhase; label: string; sub: string }> = [
    { id: 'read', label: 'Read', sub: 'Context' },
    { id: 'plan', label: 'Plan', sub: 'Strategy' },
    { id: 'execute', label: 'Execute', sub: 'Ignite' },
    { id: 'verify', label: 'Verify', sub: 'Test' },
    { id: 'report', label: 'Report', sub: 'Done' },
  ];

  function renderCard(t: KanbanTask, phaseId: PipelinePhase, rowLabel: string): string {
    const isOrigin = t.phase === phaseId;
    const border = isOrigin ? 'border-left: 3px solid #a63f2b;' : '';
    const priority = t.highPriority ? ' high-priority' : '';
    return `
      <div class="kanban-card${priority}" style="${border}" data-id="${t.id}" data-phase="${phaseId}" data-row="${esc(rowLabel)}">
        <div>
          <span class="priority-badge">${esc(t.badge)}</span>
          <h4 class="card-title">${esc(t.title)}</h4>
          <p class="card-desc">${esc(t.description)}</p>
        </div>
        <div class="card-footer">
          <span class="provider-tag">${esc(t.tag)}</span>
          <div class="avatar">${t.title.substring(0, 2).toUpperCase()}</div>
        </div>
      </div>`;
  }

  // Build column HTML
  const columnsHtml = PHASES.map(phase => {
    const header = `<div class="column-header">${phase.label} <span>${phase.sub}</span></div>`;
    const cells = ROWS.map(row => {
      const key = `${row.id}|${phase.id}`;
      const tasksInCell = grid.get(key) ?? [];
      if (tasksInCell.length === 0) {
        return `<div class="empty-slot" data-row="${esc(row.label)}">Empty</div>`;
      }
      return tasksInCell.map(t => renderCard(t, phase.id, row.label)).join('\n');
    }).join('\n');
    return `<div class="kanban-column" data-col="${phase.id}">${header}\n${cells}</div>`;
  }).join('\n');

  // Row headers
  const rowHeaders = ROWS.map(r =>
    `<div class="row-header-card"><h3>${r.label}</h3><span>${r.sub}</span></div>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aura — Kanban Pipeline</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,400;0,600;1,400&display=swap');

:root {
  --bg-base: #ebd5c9; --bg-board: #d6bdae; --bg-column: #e8d0c3;
  --bg-card: #fcf9f7; --text-main: #3d2b25; --text-muted: #7a5f54;
  --accent-red: #a34c38; --accent-glow: rgba(163, 76, 56, 0.4);
  --gold: #b38b59; --border-light: rgba(179, 139, 89, 0.25);
  --border-strong: rgba(179, 139, 89, 0.6);
  --shadow-soft: 0 8px 24px rgba(61, 43, 37, 0.08);
  --shadow-hover: 0 12px 32px rgba(61, 43, 37, 0.15);
  --pattern-opacity: 0.06; --btn-text: #ffffff;
  --accent-green: #5a9e6e; --accent-gold: #d4903a;
}
[data-theme="dark"] {
  --bg-base: #1c1311; --bg-board: #2b1d1a; --bg-column: #382622;
  --bg-card: #45302b; --text-main: #f5ebe6; --text-muted: #bda399;
  --accent-red: #d9684f; --accent-glow: rgba(217, 104, 79, 0.6);
  --gold: #d6af7a; --border-light: rgba(214, 175, 122, 0.15);
  --border-strong: rgba(214, 175, 122, 0.4);
  --shadow-soft: 0 8px 24px rgba(0, 0, 0, 0.4);
  --shadow-hover: 0 12px 32px rgba(0, 0, 0, 0.6);
  --pattern-opacity: 0.03; --btn-text: #1c1311;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  padding: 30px 20px; background-color: var(--bg-base);
  background-image:
    radial-gradient(circle at 15% 50%, rgba(179, 139, 89, var(--pattern-opacity)), transparent 25%),
    radial-gradient(circle at 85% 30%, rgba(163, 76, 56, var(--pattern-opacity)), transparent 25%);
  font-family: 'Inter', sans-serif; color: var(--text-main);
  display: flex; flex-direction: column; align-items: center;
  min-height: 100vh; transition: background-color 0.4s ease, color 0.4s ease;
}
.theme-toggle-wrapper { position: absolute; top: 30px; right: 40px; }
.theme-toggle {
  background: var(--bg-card); border: 1px solid var(--border-strong);
  color: var(--text-main); padding: 10px 18px; border-radius: 30px;
  cursor: pointer; font-family: 'Inter', sans-serif; font-weight: 600;
  font-size: 0.85rem; display: flex; align-items: center; gap: 8px;
  box-shadow: var(--shadow-soft); transition: all 0.3s ease;
}
.theme-toggle:hover { transform: translateY(-2px); border-color: var(--gold); box-shadow: var(--shadow-hover); }
header { text-align: center; margin-bottom: 40px; width: 100%; }
.project-subtitle {
  font-size: 0.85rem; text-transform: uppercase; letter-spacing: 5px;
  color: var(--gold); margin: 0 0 10px 0; font-weight: 600;
}
h1 {
  font-family: 'Playfair Display', serif; font-size: 4.5rem; font-weight: 400;
  letter-spacing: 12px; color: var(--text-main); margin: 0; text-indent: 12px;
  text-shadow: 0 4px 20px rgba(0,0,0,0.05);
}
.project-motto {
  font-family: 'Playfair Display', serif; font-style: italic;
  font-size: 1.1rem; color: var(--text-muted); margin-top: 10px;
}

/* ── Control bar ──────────────────────────────── */
.controls { display: flex; justify-content: center; gap: 12px; margin-bottom: 20px; z-index: 10; }
.btn {
  padding: 12px 28px; border-radius: 30px; border: none; font-weight: 700;
  cursor: pointer; font-size: 0.95rem; letter-spacing: 0.5px; transition: all 0.2s;
}
.btn-run { background: var(--accent-red); color: #fff; box-shadow: 0 4px 15px var(--accent-glow); }
.btn-run:hover { transform: translateY(-2px); box-shadow: 0 6px 20px var(--accent-glow); }
.btn-run:disabled { background: #999; cursor: not-allowed; transform: none; box-shadow: none; }
.btn-report { background: var(--gold); color: var(--btn-text); }
.btn-report:hover { transform: translateY(-2px); box-shadow: 0 4px 15px rgba(179, 139, 89, 0.4); }

/* ── Status bar ───────────────────────────────── */
.status-bar {
  text-align: center; padding: 14px 24px; margin-bottom: 24px;
  border-radius: 16px; font-size: 0.95rem; font-weight: 600;
  border: 1px solid var(--border-light); transition: .3s;
  box-shadow: var(--shadow-soft);
}
.status-bar.idle { background: var(--bg-card); color: var(--text-muted); }
.status-bar.running { background: var(--accent-gold); color: #fff; animation: pulse 1.5s infinite; }
.status-bar.done { background: var(--accent-green); color: #fff; }
.status-bar.error { background: var(--accent-red); color: #fff; }
@keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.7 } }

/* ── Board ────────────────────────────────────── */
.kanban-container {
  display: grid; grid-template-columns: 220px repeat(5, 1fr); gap: 16px;
  width: 100%; max-width: 1500px; background-color: var(--bg-board);
  padding: 24px; border-radius: 24px; border: 1px solid var(--border-light);
  box-shadow: var(--shadow-soft); overflow-x: auto;
  transition: background-color 0.4s ease, border-color 0.4s ease;
}
.row-headers-column { display: grid; grid-template-rows: 60px repeat(4, 1fr); gap: 16px; }
.board-corner { height: 60px; }
.row-header-card {
  background-color: transparent; border-right: 2px solid var(--border-strong);
  display: flex; flex-direction: column; justify-content: center;
  padding-right: 15px; text-align: right;
}
.row-header-card h3 { margin: 0; font-family: 'Playfair Display', serif; font-size: 1.1rem; font-weight: 600; }
.row-header-card span { font-size: 0.75rem; color: var(--text-muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 2px; }

.kanban-column { display: grid; grid-template-rows: 60px repeat(4, 1fr); gap: 16px; }
.column-header {
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  background-color: var(--bg-column); border-radius: 12px;
  font-family: 'Playfair Display', serif; font-size: 1.1rem;
  border: 1px solid var(--border-light);
  box-shadow: inset 0 2px 5px rgba(255,255,255,0.05);
}
.column-header span {
  font-family: 'Inter', sans-serif; font-size: 0.7rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: 2px; color: var(--gold); margin-top: 2px;
}

.kanban-card, .empty-slot { cursor: pointer; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
.kanban-card {
  background-color: var(--bg-card); border-radius: 16px; padding: 20px;
  box-shadow: var(--shadow-soft); display: flex; flex-direction: column;
  border: 1px solid var(--border-light); position: relative; overflow: hidden;
}
.kanban-card:hover { transform: translateY(-4px); box-shadow: var(--shadow-hover); border-color: var(--gold); }
.kanban-card::after {
  content: "\\2726"; position: absolute; top: 15px; right: 15px;
  font-size: 0.9rem; color: var(--gold); opacity: 0.4; transition: opacity 0.3s;
}
.kanban-card:hover::after { opacity: 1; }

.kanban-card.phase-active { box-shadow: 0 0 0 3px var(--accent-gold), var(--shadow-hover); }
.kanban-card.phase-done { box-shadow: 0 0 0 3px var(--accent-green), var(--shadow-soft); }
.kanban-card.phase-failed { box-shadow: 0 0 0 3px var(--accent-red), var(--shadow-soft); }

.kanban-card.high-priority {
  background-color: var(--accent-red); color: #ffffff;
  border-color: var(--accent-red); box-shadow: 0 8px 24px var(--accent-glow);
}
.kanban-card.high-priority::after { color: #ffffff; opacity: 0.8; }
.kanban-card.high-priority .card-desc, .kanban-card.high-priority .card-title { color: #ffffff; }

.priority-badge {
  font-size: 0.65rem; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 700;
  margin-bottom: 12px; display: inline-block; background: var(--bg-base);
  color: var(--text-main); padding: 4px 10px; border-radius: 20px; border: 1px solid var(--border-light);
}
.kanban-card.high-priority .priority-badge {
  background: rgba(255,255,255,0.15); color: #ffffff; border-color: rgba(255,255,255,0.3);
}
.card-title { font-family: 'Playfair Display', serif; font-size: 1.1rem; margin: 0 0 8px 0; font-weight: 600; line-height: 1.3; }
.card-desc { font-size: 0.85rem; line-height: 1.5; margin: 0 0 16px 0; color: var(--text-muted); }
.card-footer { display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; border-top: 1px solid var(--border-light); padding-top: 12px; margin-top: auto; }
.kanban-card.high-priority .card-footer { border-top-color: rgba(255,255,255,0.2); }
.provider-tag { font-weight: 600; letter-spacing: 0.5px; color: var(--gold); }
.kanban-card.high-priority .provider-tag { color: #ffffff; }
.avatar {
  width: 26px; height: 26px; border-radius: 50%; background-color: var(--bg-base);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 0.65rem; border: 1px solid var(--border-strong);
}
.empty-slot {
  border: 1px dashed var(--border-strong); border-radius: 16px; display: flex;
  align-items: center; justify-content: center; color: var(--text-muted);
  font-size: 0.8rem; font-weight: 500; letter-spacing: 1px; position: relative;
}
.empty-slot::before { content: "+"; font-size: 1.5rem; margin-right: 8px; font-weight: 300; }
.empty-slot:hover { border-style: solid; border-color: var(--gold); background-color: rgba(179, 139, 89, 0.05); color: var(--gold); }

/* ── Report panel ─────────────────────────────── */
#report-panel {
  display: none; max-width: 1000px; margin: 0 auto 20px;
  background: var(--bg-card); border-radius: 24px; padding: 32px;
  box-shadow: var(--shadow-soft); border: 1px solid var(--border-light);
}
#report-panel h2 { font-family: 'Playfair Display', serif; margin-bottom: 16px; }
#report-panel pre {
  background: #2c1e14; color: #ede0cc; padding: 16px; border-radius: 12px;
  font-size: 0.85rem; line-height: 1.6; overflow-x: auto; white-space: pre-wrap;
}
.report-stats { display: flex; gap: 20px; margin-bottom: 16px; flex-wrap: wrap; }
.stat-box {
  background: var(--bg-column); padding: 12px 20px; border-radius: 12px;
  text-align: center; min-width: 100px; border: 1px solid var(--border-light);
}
.stat-box .num { font-size: 1.8rem; font-weight: 700; font-family: 'Playfair Display', serif; }
.stat-box .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); }

/* ── Progress log ─────────────────────────────── */
#progress-log {
  max-width: 1000px; margin: 0 auto 20px; background: #2c1e14; color: #ede0cc;
  border-radius: 12px; padding: 16px; font-family: monospace; font-size: 0.8rem;
  max-height: 200px; overflow-y: auto; display: none;
}
.log-line { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
.log-line.start { color: var(--accent-gold); }
.log-line.done { color: var(--accent-green); }
.log-line.fail { color: var(--accent-red); }

footer {
  margin-top: 50px; font-family: 'Playfair Display', serif; font-size: 1.2rem;
  font-style: italic; color: var(--text-muted); letter-spacing: 2px;
  display: flex; align-items: center; gap: 15px;
}
footer::before, footer::after {
  content: ""; display: block; width: 40px; height: 1px;
  background: var(--gold); opacity: 0.5;
}

/* ── Modal ────────────────────────────────────── */
.modal-overlay {
  position: fixed; top: 0; left: 0; width: 100%; height: 100%;
  background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000; opacity: 0; pointer-events: none;
  transition: opacity 0.3s ease;
}
.modal-overlay.active { opacity: 1; pointer-events: auto; }
.modal-box {
  background-color: var(--bg-card); padding: 40px; border-radius: 24px;
  border: 1px solid var(--border-light); width: 100%; max-width: 500px;
  box-shadow: 0 24px 60px rgba(0,0,0,0.4);
  transform: translateY(20px) scale(0.95);
  transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.modal-overlay.active .modal-box { transform: translateY(0) scale(1); }
.modal-box h2 {
  font-family: 'Playfair Display', serif; margin: 0 0 24px 0;
  color: var(--text-main); font-size: 1.8rem; font-weight: 400; text-align: center;
}
.form-group { margin-bottom: 20px; display: flex; flex-direction: column; }
.form-group label {
  font-size: 0.75rem; text-transform: uppercase; letter-spacing: 2px;
  margin-bottom: 8px; font-weight: 600; color: var(--text-muted);
}
.form-group input, .form-group textarea, .form-group select {
  padding: 14px; border-radius: 12px; border: 1px solid var(--border-strong);
  background: var(--bg-base); font-family: 'Inter', sans-serif;
  font-size: 0.95rem; color: var(--text-main); transition: all 0.2s ease;
}
.form-group input:focus, .form-group textarea:focus, .form-group select:focus {
  outline: none; border-color: var(--gold);
  box-shadow: 0 0 0 3px rgba(179, 139, 89, 0.15);
}
.form-group textarea { resize: vertical; min-height: 100px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 30px; }
.btn-cancel { background: var(--bg-board); color: var(--text-main); }
.btn-cancel:hover { background: var(--border-strong); }
.btn-save { background: var(--gold); color: var(--btn-text); }
.btn-save:hover { transform: translateY(-2px); box-shadow: 0 4px 15px rgba(179, 139, 89, 0.4); }
.btn-clear {
  background: transparent; color: var(--accent-red); margin-right: auto;
  border: 1px dashed var(--accent-red);
}
.btn-clear:hover { background: rgba(163, 76, 56, 0.05); }
</style>
</head>
<body>

<div class="theme-toggle-wrapper">
  <button id="themeToggle" class="theme-toggle">
    <span id="themeIcon">\\uD83C\\uDF19</span> <span id="themeText">Dark Mode</span>
  </button>
</div>

<header>
  <div class="project-subtitle">Autonomous Coding Agent</div>
  <h1>AURA</h1>
  <div class="project-motto">"I don't try. I verify."</div>
</header>

<div class="controls">
  <button class="btn btn-run" id="runBtn" onclick="runPipeline()">\\u25B6 Execute Pipeline</button>
  <button class="btn btn-report" id="reportBtn" onclick="showReport()" style="display:none">\\uD83D\\uDCCB Show Report</button>
</div>

<div class="status-bar idle" id="statusBar">Ready \\u2014 Click "Execute Pipeline" to run all tasks through Read \\u2192 Plan \\u2192 Execute \\u2192 Verify \\u2192 Report</div>

<div id="progress-log"></div>

<div class="kanban-container" id="board">
  <div class="row-headers-column">
    <div class="board-corner"></div>
    ${rowHeaders}
  </div>
  ${columnsHtml}
</div>

<div id="report-panel">
  <h2>\\uD83D\\uDCCA Pipeline Execution Report</h2>
  <div class="report-stats" id="reportStats"></div>
  <pre id="reportContent"></pre>
</div>

<footer>let me be your Aura.</footer>

<!-- Edit / Create Modal -->
<div class="modal-overlay" id="editModal">
  <div class="modal-box">
    <h2 id="modalTitleHeader">Edit Crystal</h2>
    <form id="editForm">
      <div class="form-group">
        <label for="taskBadge">Context Badge</label>
        <input type="text" id="taskBadge" placeholder="e.g., Active Coder">
      </div>
      <div class="form-group">
        <label for="taskTitle">Objective Title</label>
        <input type="text" id="taskTitle" required placeholder="What needs to be done?">
      </div>
      <div class="form-group">
        <label for="taskDesc">Details</label>
        <textarea id="taskDesc" placeholder="Provide deeper architectural context..."></textarea>
      </div>
      <div class="form-group">
        <label for="taskTag">System Tag</label>
        <input type="text" id="taskTag" placeholder="e.g., GPT-4o, Vitest">
      </div>
      <div class="form-group">
        <label for="taskPriority">Energy Level</label>
        <select id="taskPriority">
          <option value="normal">Standard (Base Flow)</option>
          <option value="high">Ignited (High Priority)</option>
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-clear" id="clearCardBtn" style="display:none">Clear Slot</button>
        <button type="button" class="btn btn-cancel" id="closeModalBtn">Cancel</button>
        <button type="submit" class="btn btn-save">Imprint Changes</button>
      </div>
    </form>
  </div>
</div>

<script>
// Theme toggle
(function() {
  var tt = document.getElementById('themeToggle');
  var ti = document.getElementById('themeIcon');
  var tx = document.getElementById('themeText');
  if (localStorage.getItem('aura-theme') === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    ti.textContent = '\\u2600\\uFE0F'; tx.textContent = 'Light Mode';
  }
  tt.addEventListener('click', function() {
    var r = document.documentElement;
    if (r.getAttribute('data-theme') === 'dark') {
      r.setAttribute('data-theme', 'light');
      localStorage.setItem('aura-theme', 'light');
      ti.textContent = '\\uD83C\\uDF19'; tx.textContent = 'Dark Mode';
    } else {
      r.setAttribute('data-theme', 'dark');
      localStorage.setItem('aura-theme', 'dark');
      ti.textContent = '\\u2600\\uFE0F'; tx.textContent = 'Light Mode';
    }
  });
})();

// Pipeline
var ws;
var logEl = document.getElementById('progress-log');
var statusBar = document.getElementById('statusBar');

function connect() {
  ws = new WebSocket('ws://' + location.host);
  ws.onmessage = function(e) { handleProgress(JSON.parse(e.data)); };
  ws.onclose = function() { setTimeout(connect, 2000); };
}

function handleProgress(ev) {
  if (ev.type === 'phase_start') {
    setStatus('running', 'Running: ' + ev.phase.toUpperCase() + ' \\u2014 ' + ev.taskId);
    highlightCard(ev.taskId, 'active');
    addLog('\\u25B6 ' + ev.phase.toUpperCase() + ' \\u2192 ' + ev.taskId, 'start');
  } else if (ev.type === 'phase_done') {
    var icon = ev.status === 'done' ? '\\u2713' : ev.status === 'failed' ? '\\u2717' : '\\u25CB';
    highlightCard(ev.taskId, ev.status === 'done' ? 'done' : ev.status === 'failed' ? 'failed' : '');
    addLog(icon + ' ' + ev.phase.toUpperCase() + ' \\u2192 ' + ev.taskId + ' [' + ev.status + ']', ev.status === 'done' ? 'done' : 'fail');
  } else if (ev.type === 'row_done') {
    addLog('\\u2500\\u2500 Row ' + ev.row + ' complete: ' + ev.status, 'done');
  } else if (ev.type === 'pipeline_done') {
    setStatus('done', 'Pipeline complete!');
    document.getElementById('runBtn').disabled = false;
    document.getElementById('runBtn').textContent = '\\u25B6 Execute Pipeline';
    document.getElementById('reportBtn').style.display = 'inline-block';
    loadReport();
  } else if (ev.type === 'error') {
    setStatus('error', 'Error: ' + ev.message);
    document.getElementById('runBtn').disabled = false;
  }
}

function setStatus(cls, text) { statusBar.className = 'status-bar ' + cls; statusBar.textContent = text; }

function highlightCard(taskId, cls) {
  var el = document.querySelector('[data-id="' + taskId + '"]');
  if (!el) return;
  el.classList.remove('phase-active', 'phase-done', 'phase-failed');
  if (cls) el.classList.add('phase-' + cls);
}

function addLog(text, cls) {
  logEl.style.display = 'block';
  var line = document.createElement('div');
  line.className = 'log-line ' + (cls || '');
  line.textContent = text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function runPipeline() {
  var btn = document.getElementById('runBtn');
  btn.disabled = true; btn.textContent = '\\u23F3 Running...';
  document.getElementById('reportBtn').style.display = 'none';
  logEl.innerHTML = ''; logEl.style.display = 'block';
  setStatus('running', 'Starting pipeline execution...');
  addLog('Pipeline started', 'start');
  document.querySelectorAll('.kanban-card').forEach(function(c) {
    c.classList.remove('phase-active', 'phase-done', 'phase-failed');
  });
  fetch('/api/execute', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(report) {
      if (report.error) {
        setStatus('error', 'Error: ' + report.error);
        btn.disabled = false; btn.textContent = '\\u25B6 Execute Pipeline';
      }
    })
    .catch(function(e) {
      setStatus('error', 'Network error: ' + e.message);
      btn.disabled = false; btn.textContent = '\\u25B6 Execute Pipeline';
    });
}

function loadReport() {
  fetch('/api/report').then(function(r) { return r.json(); }).then(function(report) { renderReport(report); });
}

function renderReport(report) {
  document.getElementById('report-panel').style.display = 'block';
  document.getElementById('reportStats').innerHTML =
    '<div class="stat-box"><div class="num">' + report.stats.totalTasks + '</div><div class="label">Total Tasks</div></div>' +
    '<div class="stat-box"><div class="num" style="color:var(--accent-green)">' + report.stats.completed + '</div><div class="label">Completed</div></div>' +
    '<div class="stat-box"><div class="num" style="color:var(--accent-red)">' + report.stats.failed + '</div><div class="label">Failed</div></div>' +
    '<div class="stat-box"><div class="num" style="color:var(--accent-gold)">' + Math.round(report.totalDurationMs / 1000) + 's</div><div class="label">Duration</div></div>';
  var lines = [];
  lines.push('\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550');
  lines.push('  AURA \\u2014 PIPELINE EXECUTION REPORT');
  lines.push('  Generated: ' + report.generatedAt);
  lines.push('  Duration:  ' + Math.round(report.totalDurationMs / 1000) + ' seconds');
  lines.push('\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550');
  report.rows.forEach(function(row) {
    lines.push('');
    lines.push('\\u250C\\u2500 ' + row.label + ' [' + row.status.toUpperCase() + ']');
    row.executions.forEach(function(exec) {
      var icon = exec.status === 'done' ? '\\u2713' : exec.status === 'failed' ? '\\u2717' : '\\u25CB';
      lines.push('\\u2502');
      lines.push('\\u2502  ' + icon + ' ' + exec.task.title);
      lines.push('\\u2502    Badge: ' + exec.task.badge + ' | Tag: ' + exec.task.tag);
      exec.phases.forEach(function(phase) {
        var pIcon = phase.status === 'done' ? '\\u2713' : phase.status === 'failed' ? '\\u2717' : '\\u2580';
        lines.push('\\u2502    [' + pIcon + ' ' + phase.phase.toUpperCase() + '] ' + phase.status + ' (' + phase.durationMs + 'ms)');
        if (phase.output) phase.output.split('\\n').forEach(function(l) { lines.push('\\u2502      ' + l); });
      });
      lines.push('\\u2502');
    });
    lines.push('\\u2514\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500');
  });
  lines.push('');
  lines.push('  SUMMARY: ' + report.stats.totalTasks + ' tasks, ' + report.stats.completed + ' completed, ' + report.stats.failed + ' failed');
  document.getElementById('reportContent').textContent = lines.join('\\n');
}

function showReport() { document.getElementById('report-panel').scrollIntoView({ behavior: 'smooth' }); }

// ── Board interaction: click card → modal, click empty → modal, save/clear ──
(function() {
  var currentTarget = null;
  var board = document.getElementById('board');
  var modal = document.getElementById('editModal');
  var editForm = document.getElementById('editForm');
  var taskBadge = document.getElementById('taskBadge');
  var taskTitle = document.getElementById('taskTitle');
  var taskDesc = document.getElementById('taskDesc');
  var taskTag = document.getElementById('taskTag');
  var taskPriority = document.getElementById('taskPriority');
  var closeModalBtn = document.getElementById('closeModalBtn');
  var clearCardBtn = document.getElementById('clearCardBtn');

  board.addEventListener('click', function(e) {
    var square = e.target.closest('.kanban-card, .empty-slot');
    if (!square) return;
    currentTarget = square;
    var isCard = square.classList.contains('kanban-card');

    if (isCard) {
      taskBadge.value = square.querySelector('.priority-badge') ? square.querySelector('.priority-badge').innerText : '';
      taskTitle.value = square.querySelector('.card-title') ? square.querySelector('.card-title').innerText : '';
      taskDesc.value = square.querySelector('.card-desc') ? square.querySelector('.card-desc').innerText : '';
      taskTag.value = square.querySelector('.provider-tag') ? square.querySelector('.provider-tag').innerText : '';
      taskPriority.value = square.classList.contains('high-priority') ? 'high' : 'normal';
      clearCardBtn.style.display = 'block';
    } else {
      taskBadge.value = '';
      taskTitle.value = '';
      taskDesc.value = '';
      taskTag.value = '';
      taskPriority.value = 'normal';
      clearCardBtn.style.display = 'none';
    }
    modal.classList.add('active');
  });

  function closeModal() { modal.classList.remove('active'); currentTarget = null; }
  closeModalBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', function(e) { if (e.target === modal) closeModal(); });

  clearCardBtn.addEventListener('click', function() {
    if (!currentTarget) return;
    var rowAttr = currentTarget.getAttribute('data-row');
    var emptySlot = document.createElement('div');
    emptySlot.className = 'empty-slot';
    if (rowAttr) emptySlot.setAttribute('data-row', rowAttr);
    emptySlot.textContent = 'Empty';
    currentTarget.replaceWith(emptySlot);
    closeModal();
  });

  editForm.addEventListener('submit', function(e) {
    e.preventDefault();
    if (!currentTarget) return;
    var rowAttr = currentTarget.getAttribute('data-row');
    var card = document.createElement('div');
    card.className = 'kanban-card';
    if (taskPriority.value === 'high') card.classList.add('high-priority');
    if (rowAttr) card.setAttribute('data-row', rowAttr);

    var topDiv = document.createElement('div');
    if (taskBadge.value.trim()) {
      var badge = document.createElement('span');
      badge.className = 'priority-badge';
      badge.innerText = taskBadge.value;
      topDiv.appendChild(badge);
    }
    var h4 = document.createElement('h4');
    h4.className = 'card-title';
    h4.innerText = taskTitle.value || 'New Objective';
    topDiv.appendChild(h4);

    var p = document.createElement('p');
    p.className = 'card-desc';
    p.innerText = taskDesc.value || 'No description provided.';
    topDiv.appendChild(p);

    var footer = document.createElement('div');
    footer.className = 'card-footer';
    var tagSpan = document.createElement('span');
    tagSpan.className = 'provider-tag';
    tagSpan.innerText = taskTag.value || 'System';
    footer.appendChild(tagSpan);
    var avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.innerText = (taskTitle.value || 'XX').substring(0, 2).toUpperCase();
    footer.appendChild(avatar);

    card.appendChild(topDiv);
    card.appendChild(footer);
    currentTarget.replaceWith(card);
    closeModal();
  });
})();

connect();
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown report renderer
// ─────────────────────────────────────────────────────────────────────────────

function renderReportMarkdown(report: PipelineReport): string {
  const lines: string[] = [];

  lines.push('# Aura Code — Pipeline Execution Report');
  lines.push('');
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Duration:** ${(report.totalDurationMs / 1000).toFixed(1)}s`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Tasks | ${report.stats.totalTasks} |`);
  lines.push(`| Completed | ${report.stats.completed} |`);
  lines.push(`| Failed | ${report.stats.failed} |`);
  lines.push(`| Skipped | ${report.stats.skipped} |`);
  lines.push('');

  for (const row of report.rows) {
    lines.push(`## ${row.label} — ${row.status.toUpperCase()}`);
    lines.push('');

    for (const exec of row.executions) {
      const icon = exec.status === 'done' ? '✅' : exec.status === 'failed' ? '❌' : '⏭️';
      lines.push(`### ${icon} ${exec.task.title}`);
      lines.push('');
      lines.push(`- **Badge:** ${exec.task.badge}`);
      lines.push(`- **Tag:** ${exec.task.tag}`);
      lines.push(`- **Priority:** ${exec.task.highPriority ? 'HIGH' : 'Normal'}`);
      lines.push(`- **Status:** ${exec.status}`);
      lines.push('');

      for (const phase of exec.phases) {
        const pIcon = phase.status === 'done' ? '✓' : phase.status === 'failed' ? '✗' : '⊘';
        lines.push(`**${pIcon} ${phase.phase.toUpperCase()}** (${phase.durationMs}ms) — ${phase.status}`);
        if (phase.output) {
          lines.push('```');
          lines.push(phase.output);
          lines.push('```');
        }
        lines.push('');
      }
    }
  }

  lines.push('---');
  lines.push('*Generated by Aura Code Kanban Pipeline Server*');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
