// ─────────────────────────────────────────────────────────────────────────────
// Web setup wizard — the "next, next, finish" step the installers launch
//
// The TUI wizard (provider-wizard.ts) assumes someone is already at a prompt.
// Someone who just double-clicked an installer is not. This serves the same
// three decisions — provider, model, API key — as a local web page, so every
// installer on every OS can end with `aura setup --web` and hand the user a
// browser instead of a terminal.
//
// Same security posture as `aura serve`: loopback bind, per-run token on every
// route, Origin checked. The page holds an API key in a form field, so it must
// not be reachable from the LAN or drivable cross-origin.
// ─────────────────────────────────────────────────────────────────────────────

import * as http from 'http';
import * as crypto from 'crypto';
import express from 'express';
import { PROVIDER_REGISTRY, detectExistingKey, findProviderByName } from './provider-registry.js';
import { testProviderConnection, normalizeBaseUrl } from './provider-test.js';
import { saveProviderConfig } from './provider-wizard.js';
import { openExternal } from '../util/open.js';

export interface WebWizardOptions {
  port: number;
  open: boolean;
}

export interface WebWizardResult {
  provider: string;
  model: string;
  saved: boolean;
}

/**
 * Serve the setup wizard and resolve once the user finishes (or the page is
 * abandoned and the process is killed). Resolves with the saved selection.
 */
export async function runWebWizard(opts: WebWizardOptions): Promise<WebWizardResult | null> {
  const app = express();
  const server = http.createServer(app);
  const token = crypto.randomBytes(24).toString('hex');
  const host = '127.0.0.1';
  const url = `http://${host}:${opts.port}/?token=${token}`;

  app.use(express.json());

  app.use((req, res, next) => {
    const provided = (req.query.token as string | undefined) ?? req.header('x-aura-token');
    if (provided !== token) {
      res.status(401).send('Unauthorized: missing or invalid token.');
      return;
    }
    // A browser form posting an API key must not be drivable from another
    // origin, so reject anything that declares a foreign one.
    const origin = req.header('origin');
    if (origin && origin !== `http://${host}:${opts.port}` && origin !== `http://localhost:${opts.port}`) {
      res.status(403).send('Forbidden: bad origin.');
      return;
    }
    next();
  });

  return new Promise<WebWizardResult | null>(resolve => {
    let settled = false;
    const finish = (result: WebWizardResult | null): void => {
      if (settled) return;
      settled = true;
      // Let the success response flush before tearing the socket down.
      setTimeout(() => server.close(() => resolve(result)), 250);
    };

    app.get('/', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.send(buildWizardUI(token));
    });

    // Provider catalogue — base URLs and model lists come from the registry,
    // so the page never hardcodes an endpoint of its own.
    app.get('/api/providers', (_req, res) => {
      res.json(PROVIDER_REGISTRY.map(p => ({
        name: p.name,
        baseUrl: p.baseUrl,
        signupUrl: p.signupUrl,
        needsKey: p.envKey !== null,
        // Ollama and Custom carry no catalogue — the user supplies the id.
        freeform: p.models.length === 0,
        hasExistingKey: !!detectExistingKey(p),
        models: p.models.map(m => ({
          id: m.id,
          label: m.label,
          speed: m.speed,
          contextWindow: m.contextWindow,
        })),
      })));
    });

    app.post('/api/test', async (req, res) => {
      const { provider, model, apiKey, baseUrl } = req.body ?? {};
      const entry = findProviderByName(String(provider ?? ''));
      if (!entry) { res.json({ ok: false, error: 'Unknown provider.' }); return; }

      const effectiveBase = normalizeBaseUrl(String(baseUrl || entry.baseUrl || ''));
      if (!effectiveBase) { res.json({ ok: false, error: 'A base URL is required.' }); return; }
      if (!model) { res.json({ ok: false, error: 'A model is required.' }); return; }

      try {
        const result = await testProviderConnection({
          provider: entry.name,
          model: String(model),
          baseUrl: effectiveBase,
          apiKey: apiKey ? String(apiKey) : undefined,
        });
        res.json(result);
      } catch (e) {
        res.json({ ok: false, error: String(e) });
      }
    });

    app.post('/api/save', (req, res) => {
      const { provider, model, apiKey, baseUrl } = req.body ?? {};
      const entry = findProviderByName(String(provider ?? ''));
      if (!entry) { res.status(400).json({ ok: false, error: 'Unknown provider.' }); return; }
      if (!model) { res.status(400).json({ ok: false, error: 'A model is required.' }); return; }

      const effectiveBase = normalizeBaseUrl(String(baseUrl || entry.baseUrl || ''));
      try {
        // Reuse the TUI wizard's persistence so both front ends write the
        // key store, global config, and provider.json identically.
        saveProviderConfig({
          provider: entry.name,
          model: String(model),
          baseUrl: effectiveBase,
          apiKey: apiKey ? String(apiKey) : undefined,
        });
        res.json({ ok: true });
        finish({ provider: entry.name, model: String(model), saved: true });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });

    // The page calls this when the user chooses to skip configuration.
    app.post('/api/skip', (_req, res) => {
      res.json({ ok: true });
      finish(null);
    });

    server.listen(opts.port, host, () => {
      console.log('\n  Aura — setup');
      console.log('  Open this page to finish setup:');
      console.log('  ' + url + '\n');
      if (opts.open) openExternal(url);
    });

    server.on('error', () => finish(null));
  });
}

function buildWizardUI(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Aura — Setup</title>
<style>
:root{
  --ink:#0a1020;--ink2:#101a2c;--s:#162034;--cream:#eaf1f7;--dim:#aebccd;
  --blue:#6ed0ea;--blue-hot:#cdf0f8;--ruby:#d24b30;--copper:#d98e63;
  --line:#22304a;--g:#5a9e6e;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--ink);color:var(--cream);font-family:system-ui,-apple-system,sans-serif;
  min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-size:15px}
.card{width:100%;max-width:560px;background:var(--ink2);border:1px solid var(--line);
  border-radius:16px;padding:32px;box-shadow:0 18px 50px rgba(0,0,0,.45)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.mark{width:30px;height:30px;flex-shrink:0}
h1{font-size:21px;font-weight:600;letter-spacing:.01em}
.sub{color:var(--dim);font-size:13px;margin-bottom:22px}
.steps{display:flex;gap:6px;margin-bottom:24px}
.stp{flex:1;height:3px;background:var(--line);border-radius:2px;transition:background .3s}
.stp.on{background:var(--blue)}
.pane{display:none}
.pane.on{display:block}
label{display:block;font-size:12px;color:var(--dim);margin-bottom:7px;letter-spacing:.02em}
select,input{width:100%;background:var(--s);border:1px solid var(--line);color:var(--cream);
  border-radius:9px;padding:11px 13px;font-size:14px;font-family:inherit}
select:focus,input:focus{outline:none;border-color:var(--blue)}
.fld{margin-bottom:18px}
.hint{font-size:12px;color:var(--dim);margin-top:7px;line-height:1.5}
.hint a{color:var(--blue)}
.row{display:flex;gap:10px;margin-top:24px}
button{border:none;border-radius:9px;padding:11px 20px;font-size:14px;font-weight:600;
  cursor:pointer;font-family:inherit}
.pri{background:var(--blue);color:var(--ink);flex:1}
.pri:disabled{background:var(--line);color:var(--dim);cursor:not-allowed}
.sec{background:transparent;color:var(--dim);border:1px solid var(--line)}
.msg{margin-top:16px;padding:11px 13px;border-radius:9px;font-size:13px;line-height:1.5;display:none}
.msg.on{display:block}
.msg.err{background:rgba(210,75,48,.12);border:1px solid rgba(210,75,48,.35);color:#ffb4a6}
.msg.ok{background:rgba(90,158,110,.12);border:1px solid rgba(90,158,110,.35);color:#a6e0b8}
.msg.info{background:rgba(110,208,234,.08);border:1px solid rgba(110,208,234,.25);color:var(--dim)}
.done{text-align:center;padding:16px 0}
.done .big{font-size:44px;margin-bottom:14px}
.done h2{font-size:19px;margin-bottom:9px}
.done p{color:var(--dim);font-size:13px;line-height:1.6}
code{background:var(--s);padding:2px 7px;border-radius:5px;font-size:12.5px;color:var(--blue-hot)}
.spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(10,16,32,.3);
  border-top-color:var(--ink);border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:7px}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="card">
  <div class="brand">
    <svg class="mark" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="none" stroke="#6ed0ea" stroke-width="2"/><circle cx="16" cy="16" r="5" fill="#d24b30"/></svg>
    <h1>Welcome to Aura</h1>
  </div>
  <div class="sub">Two quick steps and you're ready to go.</div>

  <div class="steps"><div class="stp on" id="s1"></div><div class="stp" id="s2"></div><div class="stp" id="s3"></div></div>

  <!-- Step 1 — provider + model -->
  <div class="pane on" id="p1">
    <div class="fld">
      <label for="prov">Choose your AI provider</label>
      <select id="prov"></select>
      <div class="hint" id="provHint"></div>
    </div>
    <div class="fld" id="modelFld">
      <label for="model">Model</label>
      <select id="model"></select>
    </div>
    <div class="fld" id="modelFreeFld" style="display:none">
      <label for="modelFree">Model name</label>
      <input id="modelFree" placeholder="e.g. llama3.2" autocomplete="off"/>
      <div class="hint" id="freeHint"></div>
    </div>
    <div class="fld" id="baseFld" style="display:none">
      <label for="baseUrl">API base URL</label>
      <input id="baseUrl" placeholder="https://api.example.com/v1" autocomplete="off"/>
    </div>
    <div class="row">
      <button class="pri" id="next1">Continue</button>
    </div>
  </div>

  <!-- Step 2 — API key -->
  <div class="pane" id="p2">
    <div class="fld">
      <label for="key">API key</label>
      <input id="key" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false"/>
      <div class="hint" id="keyHint"></div>
    </div>
    <div class="msg" id="m2"></div>
    <div class="row">
      <button class="sec" id="back2">Back</button>
      <button class="pri" id="next2">Test &amp; finish</button>
    </div>
  </div>

  <!-- Step 3 — done -->
  <div class="pane" id="p3">
    <div class="done">
      <div class="big">✓</div>
      <h2>Aura is ready</h2>
      <p id="doneMsg"></p>
      <p style="margin-top:14px">You can close this tab and run <code>aura</code> in any project folder.</p>
    </div>
  </div>
</div>

<script>
var TOKEN = ${JSON.stringify(token)};
var PROVIDERS = [], cur = null;

function api(path, body) {
  return fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Aura-Token': TOKEN },
    body: body ? JSON.stringify(body) : undefined
  }).then(function(r) { return r.json(); });
}
function el(id) { return document.getElementById(id); }
function show(n) {
  ['p1','p2','p3'].forEach(function(p, i) { el(p).className = 'pane' + (i === n - 1 ? ' on' : ''); });
  ['s1','s2','s3'].forEach(function(s, i) { el(s).className = 'stp' + (i < n ? ' on' : ''); });
}
function msg(id, text, kind) {
  var e = el(id);
  e.className = 'msg on ' + kind;
  e.textContent = text;
}

api('/api/providers').then(function(list) {
  PROVIDERS = list;
  var sel = el('prov');
  list.forEach(function(p, i) {
    var o = document.createElement('option');
    o.value = p.name; o.textContent = p.name; sel.appendChild(o);
  });
  onProvider();
});

function onProvider() {
  cur = PROVIDERS.filter(function(p) { return p.name === el('prov').value; })[0];
  if (!cur) return;

  el('modelFld').style.display = cur.freeform ? 'none' : 'block';
  el('modelFreeFld').style.display = cur.freeform ? 'block' : 'none';
  el('baseFld').style.display = cur.baseUrl ? 'none' : 'block';

  var hint = cur.baseUrl ? 'Endpoint: ' + cur.baseUrl : 'You will provide the endpoint below.';
  if (cur.hasExistingKey) hint += ' — an existing key was found for this provider.';
  el('provHint').textContent = hint;

  el('freeHint').textContent = cur.name.indexOf('Ollama') === 0
    ? 'Whatever model you have pulled locally, e.g. llama3.2 or qwen2.5-coder.'
    : 'The exact model id your endpoint expects.';

  var ms = el('model'); ms.innerHTML = '';
  cur.models.forEach(function(m) {
    var o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label + ' \\u2014 ' + m.speed;
    ms.appendChild(o);
  });
}
el('prov').onchange = onProvider;

el('next1').onclick = function() {
  if (!cur) return;
  if (!cur.baseUrl && !el('baseUrl').value.trim()) { alert('Please enter the API base URL.'); return; }
  if (cur.freeform && !el('modelFree').value.trim()) { alert('Please enter a model name.'); return; }

  if (!cur.needsKey) { finish(); return; }   // Ollama / custom without a key

  el('keyHint').innerHTML = cur.signupUrl
    ? 'Need one? Get a key at <a href="' + cur.signupUrl + '" target="_blank" rel="noreferrer">' + cur.signupUrl + '</a>. It is stored on this machine only.'
    : 'Stored on this machine only.';
  if (cur.hasExistingKey) {
    msg('m2', 'A key for this provider already exists. Leave the field blank to keep using it.', 'info');
  }
  show(2);
};
el('back2').onclick = function() { show(1); };
el('next2').onclick = finish;

function chosenModel() { return cur.freeform ? el('modelFree').value.trim() : el('model').value; }
function chosenBase()  { return cur.baseUrl || el('baseUrl').value.trim(); }

function finish() {
  var btn = el('next2');
  var payload = {
    provider: cur.name,
    model: chosenModel(),
    baseUrl: chosenBase(),
    apiKey: el('key').value.trim() || undefined
  };

  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Testing\\u2026';

  api('/api/test', payload).then(function(r) {
    if (!r.ok) {
      msg('m2', r.error || 'Could not reach the provider with that key.', 'err');
      btn.disabled = false; btn.textContent = 'Test & finish';
      return;
    }
    return api('/api/save', payload).then(function(s) {
      if (!s.ok) {
        msg('m2', s.error || 'Could not save the configuration.', 'err');
        btn.disabled = false; btn.textContent = 'Test & finish';
        return;
      }
      el('doneMsg').textContent = payload.provider + ' \\u00b7 ' + payload.model;
      show(3);
    });
  }).catch(function(e) {
    msg('m2', String(e), 'err');
    btn.disabled = false; btn.textContent = 'Test & finish';
  });
}
</script>
</body>
</html>`;
}
