#!/usr/bin/env node
/**
 * Probe free model fallbacks — run this when the Telegram bot stops answering.
 *
 * OpenRouter retires `:free` ids without notice. The four ids that shipped in
 * provider-registry.ts were already dead when this was written, which is why a
 * fallback list is a cache of a past probe and never a fact. This script is the
 * refresh: it asks OpenRouter what is free right now, then actually calls each
 * one and reports whether it answered, how fast, and whether it can take tools.
 *
 *   node scripts/probe-free-models.mjs
 *   node scripts/probe-free-models.mjs --rediscover   # list every live :free id
 *
 * Exit code is 1 when no listed model answered, so it can gate a cron job.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LISTED = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'cohere/north-mini-code:free',
  'dots-studio/dots-3-note-preview:free',
  'recursive/flint-v1.0:free',
  'nvidia/nemotron-3.5-lightning:free',
];

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const k = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.aura', 'keys.json'), 'utf8'));
    return k.OPENROUTER_API_KEY;
  } catch { return undefined; }
}

const key = apiKey();
if (!key) {
  console.error('No OPENROUTER_API_KEY in env or ~/.aura/keys.json');
  process.exit(2);
}

const HDRS = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function call(model, timeoutMs = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: ac.signal, headers: HDRS,
      body: JSON.stringify({
        model, max_tokens: 300,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      }),
    });
    const j = await r.json();
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, ms, why: `${r.status} ${j?.error?.message ?? ''}`.trim() };
    const text = (j.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim();
    // A reasoning model can burn max_tokens before emitting text; empty is not
    // proof of health, so it counts as a failure rather than a silent success.
    return text ? { ok: true, ms, text } : { ok: false, ms, why: 'empty content' };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, why: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(timer); }
}

if (process.argv.includes('--rediscover')) {
  const r = await fetch('https://openrouter.ai/api/v1/models', { headers: HDRS });
  const j = await r.json();
  const free = (j.data ?? []).filter(m => String(m.id).endsWith(':free'));
  console.log(`${free.length} free model(s) live now:\n`);
  for (const m of free) {
    const tools = (m.supported_parameters ?? []).includes('tools') ? 'tools' : 'no-tools';
    console.log(`  ${m.id}  ctx=${m.context_length}  ${tools}`);
  }
  process.exit(0);
}

const models = process.argv.slice(2).filter(a => !a.startsWith('--'));
const targets = models.length ? models : LISTED;
let alive = 0;
for (const m of targets) {
  // Bare id on the wire: the 'openrouter/' prefix in FALLBACK_CHAT_MODELS is
  // Aura's provider routing and is not part of the OpenRouter model name.
  const r = await call(m.replace(/^openrouter\//, ''));
  if (r.ok) alive++;
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} openrouter/${m}  ${r.ms}ms  ${r.ok ? JSON.stringify(r.text.slice(0, 40)) : r.why}`);
}
console.log(`\n${alive}/${targets.length} answered`);
process.exit(alive ? 0 : 1);
