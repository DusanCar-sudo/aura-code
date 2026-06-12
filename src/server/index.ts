import * as http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createProvider, KNOWN_MODELS } from '../providers/factory.js';
import { loadProjectContext } from '../agent/context.js';
import { runAgentLoop } from '../agent/loop.js';
import { PermissionSystem } from '../safety/permissions.js';
import { Session } from './session.js';
import { routeTask, createPlan, executePlan } from '../orchestration/index.js';
import type { Display } from '../cli/display.js';
import type { ProviderConfig } from '../providers/types.js';

export interface ServeOptions {
  port: number; cwd: string; model: string;
  apiKey?: string; baseUrl?: string; open: boolean;
}

export async function startServer(opts: ServeOptions): Promise<void> {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  app.use(express.json());
  const ctx = await loadProjectContext(opts.cwd);
  const session = new Session();

  console.log('\n  BootstrapRuby \u2014 web client');
  console.log('  Project : ' + ctx.name + ' \u00b7 ' + ctx.language);
  console.log('  Model   : ' + opts.model);
  console.log('  URL     : http://localhost:' + opts.port + '\n');

  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(buildUI(ctx.name, opts.model));
  });
  app.get('/api/history', (_req, res) => res.json(session.getDisplay()));
  app.get('/api/project', (_req, res) => res.json({
    name: ctx.name, language: ctx.language, model: opts.model, models: KNOWN_MODELS,
  }));
  app.post('/api/reset', (_req, res) => { session.reset(); res.json({ ok: true }); });

  wss.on('connection', (ws) => {
    send(ws, { type: 'connected' });
    ws.on('message', async (raw) => {
      let msg: { type: string; task?: string; model?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'task' && msg.task) await runTask(ws, msg.task, msg.model ?? opts.model);
      if (msg.type === 'reset') { session.reset(); send(ws, { type: 'reset_ok' }); }
    });
  });

  async function runTask(ws: WebSocket, task: string, model: string): Promise<void> {
    session.addUser(task);
    let provider;
    try { provider = createProvider({ model, apiKey: opts.apiKey, baseUrl: opts.baseUrl } as ProviderConfig); }
    catch (e) { send(ws, { type: 'error', message: String(e) }); return; }

    const display: Display = {
      agentThinking: () => send(ws, { type: 'thinking' }),
      streamText: (t) => send(ws, { type: 'text', text: t }),
      streamEnd: () => send(ws, { type: 'text_end' }),
      toolStart: () => {},
      toolCall: (name, input) => send(ws, { type: 'tool_call', name, input }),
      toolResult: (name, result, ms) => send(ws, { type: 'tool_result', name, result, ms }),
      toolBlocked: (name, reason) => send(ws, { type: 'tool_blocked', name, reason }),
      warning: (msg) => send(ws, { type: 'warning', message: msg }),
      success: () => {},
      error: (msg) => send(ws, { type: 'error', message: msg }),
      header: () => {},
      summary: (text, turns, toolCount) => send(ws, { type: 'done', text, turns, toolCount, success: true }),
      showPlan: (plan) => send(ws, { type: 'plan_created', plan }),
      stepStarted: (step) => send(ws, { type: 'step_started', step }),
      stepCompleted: (step, result) => send(ws, { type: 'step_completed', step, result }),
    };

    // Try orchestration first
    try {
      const decision = await routeTask({ provider, context: ctx, task });
      if (decision.shouldDecompose) {
        send(ws, { type: 'plan_creating' });
        const plan = await createPlan({ provider, context: ctx, task });
        send(ws, { type: 'plan_created', plan });

        const executedPlan = await executePlan({ provider, context: ctx, plan, display });
        const text = executedPlan.outcome ?? 'Plan completed.';
        const success = executedPlan.status === 'done';
        send(ws, { type: 'plan_done', outcome: text, success });
        session.addAssistant(text, executedPlan.steps.length, 0);
        return;
      }
    } catch {
      // Orchestration failed — fall through to single agent
    }

    // Single agent (existing behaviour)
    const result = await runAgentLoop({
      provider, task, context: ctx,
      permissions: new PermissionSystem('normal'), display,
    });
    session.addAssistant(result.summary, result.turns, result.toolCallCount);
    send(ws, { type: 'done', success: result.success, text: result.summary, turns: result.turns, toolCount: result.toolCallCount });
  }

  server.listen(opts.port, () => {
    if (opts.open) { try { require('child_process').exec('xdg-open http://localhost:' + opts.port); } catch {} }
    console.log('  Ready \u2192 http://localhost:' + opts.port + '  (Ctrl+C to stop)\n');
  });
}

function send(ws: WebSocket, data: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function buildUI(project: string, defaultModel: string): string {
  const modelOpts = KNOWN_MODELS
    .map(m => `<option value="${m.id}">${m.provider} \u2014 ${m.name}</option>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${project} \u2014 BootstrapRuby</title>
<style>
:root{
  --bg:#0e0a06;--bg2:#150e08;--s:#1c1208;--ink:#ede0cc;--inks:#c8b5a0;
  --m:#8a7768;--f:#4e3d30;--c:#cc785c;--cd:#b15439;--g:#5a9e6e;
  --l:#2c1e14;--l2:#3a2818;--ti:rgba(204,120,92,.12);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif;font-size:14px;overflow:hidden}
.app{display:grid;grid-template-rows:52px 1fr 76px;height:100vh}
.bar{background:var(--bg2);border-bottom:1px solid var(--l2);display:flex;align-items:center;gap:12px;padding:0 20px}
.logo{font-family:Georgia,serif;font-size:17px;font-weight:600}
.logo em{font-style:italic;color:var(--c)}
.proj{font-family:monospace;font-size:11px;color:var(--m)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--f);flex-shrink:0;transition:.3s}
.dot.on{background:var(--g);box-shadow:0 0 0 3px rgba(90,158,110,.2)}
select{margin-left:auto;background:var(--s);border:1px solid var(--l2);color:var(--inks);border-radius:6px;padding:6px 10px;font-size:11px}
.btn-r{font-size:11px;color:var(--m);background:transparent;border:1px solid var(--l2);border-radius:5px;padding:5px 10px;cursor:pointer}
.btn-r:hover{border-color:var(--c);color:var(--c)}
.chat{overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:10px}
.ibar{background:var(--bg2);border-top:1px solid var(--l2);padding:14px 18px;display:flex;gap:10px;align-items:flex-end}
.iw{flex:1;background:var(--s);border:1px solid var(--l2);border-radius:12px;display:flex;align-items:flex-end;padding:8px 12px;gap:10px;transition:.2s}
.iw:focus-within{border-color:var(--c);box-shadow:0 0 0 2px rgba(204,120,92,.15)}
#inp{flex:1;background:transparent;border:none;outline:none;color:var(--ink);font-size:14px;resize:none;max-height:130px;line-height:1.5;padding:4px 0}
#inp::placeholder{color:var(--f)}
#sb{background:var(--c);color:#fff;border:none;border-radius:8px;width:36px;height:36px;cursor:pointer;font-size:18px;flex-shrink:0;transition:.2s}
#sb:hover{background:var(--cd)}
#sb:disabled{background:var(--f);cursor:not-allowed}
.mu{display:flex;justify-content:flex-end}
.mu .b{background:var(--ti);border:1px solid rgba(204,120,92,.2);border-radius:14px 14px 4px 14px;padding:11px 16px;max-width:75%;line-height:1.55}
.ma .b{background:var(--s);border:1px solid var(--l2);border-radius:4px 14px 14px 14px;padding:13px 16px;color:var(--inks);line-height:1.65;white-space:pre-wrap}
.mt{background:#1a1008;border:1px solid var(--l);border-left:2px solid var(--c);border-radius:6px;padding:9px 13px;font-family:monospace;font-size:12px}
.tn{color:var(--c);font-weight:700;margin-bottom:3px}
.ti{color:var(--m)}
.tr{color:var(--inks);margin-top:5px;padding-top:5px;border-top:1px solid var(--l);font-size:11px;white-space:pre-wrap;max-height:90px;overflow-y:auto}
.sy{font-family:monospace;font-size:11px;color:#d4903a;text-align:center;padding:4px}
.tk{display:flex;align-items:center;gap:8px;font-family:monospace;font-size:11px;color:var(--m);padding:6px 0}
.tk::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--c);flex-shrink:0;animation:p 1.2s infinite}
.sk{background:var(--s);border:1px solid var(--l2);border-left:2px solid var(--c);border-radius:6px;padding:13px 16px;color:var(--inks);line-height:1.65;white-space:pre-wrap}
.cur{display:inline-block;width:8px;height:14px;background:var(--c);margin-left:2px;animation:bk 1s steps(1) infinite;vertical-align:text-bottom}
.plc{border:1px solid var(--l2);border-radius:10px;padding:14px 16px;margin:4px 0}
.plh{color:var(--c);font-weight:700;font-size:13px;margin-bottom:8px}
.plg{color:var(--m);font-size:12px;margin-bottom:10px}
.ps{display:flex;align-items:flex-start;gap:8px;padding:6px 0;font-size:12px;border-bottom:1px solid var(--l);color:var(--inks)}
.ps:last-child{border-bottom:none}
.ps .psi{width:20px;height:20px;border-radius:50%;text-align:center;line-height:20px;font-size:11px;flex-shrink:0;margin-top:1px}
.ps.wait .psi{background:var(--f);color:var(--m)}
.ps.running .psi{background:#d4903a;color:#fff;animation:p 1.2s infinite}
.ps.done .psi{background:var(--g);color:#fff}
.ps.failed .psi{background:var(--cd);color:#fff}
.ps .psb{flex:1}
.ps .pss{font-weight:600;color:var(--inks)}
.ps .pst{color:var(--m);font-size:11px}
.ps .psr{font-size:10px;color:var(--g);margin-top:2px}
@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes bk{0%,100%{opacity:1}50%{opacity:0}}
</style>
</head>
<body>
<div class="app">
  <div class="bar">
    <div class="logo"><em>Ruby</em> Code</div>
    <div class="proj">${project}</div>
    <div class="dot" id="dot"></div>
    <select id="ms">${modelOpts}</select>
    <button class="btn-r" id="btnR">New chat</button>
  </div>
  <div class="chat" id="ch"></div>
  <div class="ibar">
    <div class="iw">
      <textarea id="inp" rows="1" placeholder="Ask anything about your code\u2026"></textarea>
      <button id="sb">\u2191</button>
    </div>
  </div>
</div>
<script>
(function() {
  var ch = document.getElementById('ch');
  var inp = document.getElementById('inp');
  var sb = document.getElementById('sb');
  var dot = document.getElementById('dot');
  var ms = document.getElementById('ms');
  var btnR = document.getElementById('btnR');

  ms.value = '${defaultModel}';
  if (!ms.value) ms.selectedIndex = 0;

  var ws, busy = false, sEl = null, sText = '', tEl = null, pEl = null;

  function conn() {
    ws = new WebSocket('ws://' + location.host);
    ws.onopen = function() { dot.className = 'dot on'; lh(); };
    ws.onclose = function() { dot.className = 'dot'; setTimeout(conn, 2000); };
    ws.onmessage = function(e) { hv(JSON.parse(e.data)); };
  }

  function hv(d) {
    if (d.type === 'plan_creating') { pEl = mk('div','plc'); pEl.innerHTML = '<div class="plh">Orchestrator</div><div class="plg">Creating execution plan\u2026</div>'; ch.appendChild(pEl); sc(); return; }
    if (d.type === 'plan_created') { rp(d.plan); sc(); return; }
    if (d.type === 'step_started') { us(d.step); sc(); return; }
    if (d.type === 'step_completed') { uf(d.step, d.result); sc(); return; }
    if (d.type === 'plan_done') { idle(); if (d.outcome) { var e = mk('div','ma'); e.innerHTML = '<div class="b">' + ex(d.outcome) + '</div>'; ch.appendChild(e); } fn(); sc(); return; }
    if (d.type === 'thinking') { rt(); var e = mk('div','tk'); e.id = 'thi'; e.textContent = 'thinking\u2026'; ch.appendChild(e); sc(); return; }
    if (d.type === 'text') { rt(); if (!sEl) { sEl = mk('div','sk'); ch.appendChild(sEl); } sText += d.text; sEl.innerHTML = ex(sText) + '<span class="cur"></span>'; sc(); return; }
    if (d.type === 'text_end' || d.type === 'done') { fn(); if (d.type === 'done') idle(); sc(); return; }
    if (d.type === 'tool_call') { rt(); var e = mk('div','mt'); e.innerHTML = '<div class="tn">' + ic(d.name) + ' ' + d.name + '</div><div class="ti">' + ex(si(d.name, d.input)) + '</div><div class="tr">running\u2026</div>'; ch.appendChild(e); tEl = e; sc(); return; }
    if (d.type === 'tool_result') { if (tEl) { var r = tEl.querySelector('.tr'), ls = d.result.split('\\n'); r.textContent = ls.length > 5 ? ls.slice(0,5).join('\\n') + '\\n\u2026(+' + (ls.length-5) + ' lines)' : d.result; } tEl = null; return; }
    if (d.type === 'error' || d.type === 'warning') { var e = mk('div','sy'); e.textContent = d.message || d.reason || ''; ch.appendChild(e); if (d.type === 'error') idle(); sc(); return; }
    if (d.type === 'reset_ok') { ch.innerHTML = ''; }
  }

  function rp(plan) {
    if (!pEl) pEl = mk('div','plc');
    var h = '<div class="plh">Execution Plan</div><div class="plg">' + ex(plan.goal||'') + '</div>';
    for (var i = 0; i < (plan.steps||[]).length; i++) {
      var s = plan.steps[i];
      var cls = s.specialist === 'researcher' ? 'R' : s.specialist === 'coder' ? 'C' : s.specialist === 'reviewer' ? 'V' : 'P';
      h += '<div class="ps wait" id="ps-' + s.id + '"><div class="psi">' + cls + '</div><div class="psb"><div class="pss">[' + s.specialist + '] ' + ex(s.task||'') + '</div></div></div>';
    }
    pEl.innerHTML = h;
  }

  function us(step) {
    var e = document.getElementById('ps-' + step.id);
    if (e) { e.className = 'ps running'; e.querySelector('.psi').textContent = '\u2026'; }
  }

  function uf(step, result) {
    var e = document.getElementById('ps-' + step.id);
    if (e) {
      e.className = result ? 'ps done' : 'ps failed';
      var cls = step.specialist === 'researcher' ? 'R' : step.specialist === 'coder' ? 'C' : step.specialist === 'reviewer' ? 'V' : 'P';
      e.querySelector('.psi').textContent = '\\u2713';
      if (result) {
        var re = mk('div','psr'); re.textContent = String(result||'').slice(0,120); e.appendChild(re);
      }
    }
  }

  function rt() { var t = document.getElementById('thi'); if (t) t.remove(); }
  function fn() { rt(); if (sEl && sText) { var d = mk('div','ma'); d.innerHTML = '<div class="b">' + ex(sText) + '</div>'; sEl.replaceWith(d); } else if (sEl) sEl.remove(); sEl = null; sText = ''; tEl = null; }
  function idle() { busy = false; sb.disabled = false; }
  function mk(tag, cls) { var e = document.createElement(tag); e.className = cls; return e; }
  function ex(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function sc() { ch.scrollTop = ch.scrollHeight; }
  function ic(n) { return ({read_file:'\ud83d\udcc4',list_dir:'\ud83d\udcc1',edit_file:'\u270f\ufe0f',write_file:'\ud83d\udcdd',search_code:'\ud83d\udd0d',run_shell:'\u26a1',run_tests:'\ud83e\uddea',git_status:'\ud83c\udf3f',git_diff:'\ud83d\udcca'})[n] || '\ud83d\udd27'; }
  function si(n, i) { if (n==='read_file') return (i.path||'') + (i.start_line ? ':'+i.start_line+'-'+(i.end_line||'?') : ''); if (n==='run_shell') return '$ ' + (i.command||''); if (n==='search_code') return '"' + (i.pattern||'') + '"'; return i.path || JSON.stringify(i).slice(0,60); }

  function go() {
    var t = inp.value.trim();
    if (!t || busy) return;
    var e = mk('div','mu'); e.innerHTML = '<div class="b">' + ex(t) + '</div>'; ch.appendChild(e);
    inp.value = ''; ar(); busy = true; sb.disabled = true;
    ws.send(JSON.stringify({ type: 'task', task: t, model: ms.value }));
    sc();
  }

  function ar() { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 130) + 'px'; }

  async function lh() {
    var msgs = await fetch('/api/history').then(function(r) { return r.json(); });
    msgs.forEach(function(m) {
      if (m.role === 'user') { var e = mk('div','mu'); e.innerHTML = '<div class="b">' + ex(m.content) + '</div>'; ch.appendChild(e); }
      else if (m.role === 'assistant' && m.content) { var e = mk('div','ma'); e.innerHTML = '<div class="b">' + ex(m.content) + '</div>'; ch.appendChild(e); }
    });
    sc();
  }

  sb.addEventListener('click', go);
  inp.addEventListener('keydown', function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
  inp.addEventListener('input', ar);
  btnR.addEventListener('click', function() { fetch('/api/reset', { method: 'POST' }); ws.send(JSON.stringify({ type: 'reset' })); });

  conn();
})();
</script>
</body>
</html>`;
}
