#!/usr/bin/env node
/**
 * Reference client for `aura sidecar` — spawns the engine, opens a session,
 * sends a message, answers the approval request, and waits for completion.
 *
 * Doubles as the protocol's executable documentation: every frame it sends
 * and receives is printed, so the transcript is the spec in action.
 *
 *   node scripts/protocol-test-client.mjs [--model <id>] [--task "..."]
 *
 * With no API key in the environment the turn ends in a provider error —
 * which still exercises the whole path (spawn → session → turn → events →
 * completion). Set a real key to see tool calls and a genuine approval.
 */
import { spawn } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const MODEL = arg('--model', process.env.AURA_MODEL ?? '');
const TASK = arg('--task', 'Create a file called protocol-demo.txt containing the word hello.');
const PROJECT_ROOT = arg('--root', process.env.TMPDIR ?? '/tmp');

const child = spawn(process.execPath, [path.join(REPO, 'dist/cli/index.js'), 'sidecar'], {
  cwd: REPO,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, AURA_NO_SETUP: '1' },
});

let nextId = 1;
const pending = new Map();

function send(frame) {
  console.log('→', JSON.stringify(frame));
  child.stdin.write(JSON.stringify(frame) + '\n');
}

function request(method, params) {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ kind: 'req', id, method, params });
  });
}

const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

let done;
const finished = new Promise(r => { done = r; });

rl.on('line', line => {
  if (!line.trim()) return;
  let frame;
  try { frame = JSON.parse(line); } catch { console.log('  (non-frame stdout):', line); return; }
  console.log('←', JSON.stringify(frame));

  if (frame.kind === 'res') {
    const p = pending.get(frame.id);
    if (p) {
      pending.delete(frame.id);
      frame.ok ? p.resolve(frame.result) : p.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
    }
    return;
  }

  // The engine asking US for permission — the bidirectional half of the
  // protocol. Answer it or the turn blocks until the timeout denies it.
  if (frame.kind === 'req' && frame.method === 'approval.request') {
    console.log(`\n  ** APPROVAL REQUESTED **  tier=${frame.params.tier} tool=${frame.params.tool || '(unnamed)'}`);
    console.log(`     ${frame.params.rendered}\n`);
    send({ kind: 'res', id: frame.id, ok: true, result: { decision: 'allow' } });
    return;
  }

  if (frame.kind === 'evt' && frame.method === 'turn.completed') {
    console.log(`\n  turn.completed — success=${frame.params.success}`);
    console.log(`  summary: ${String(frame.params.summary).slice(0, 200)}`);
    console.log(`  usage  : ${JSON.stringify(frame.params.usage)}`);
    done();
  }
});

(async () => {
  console.log('=== 1. engine.ready (emitted on connect) ===\n');
  await new Promise(r => setTimeout(r, 400));

  console.log('\n=== 2. tools.list ===\n');
  const tools = await request('tools.list', {});
  console.log(`  ${tools.tools.length} tools: ${tools.tools.map(t => t.name).slice(0, 8).join(', ')}…`);

  console.log('\n=== 3. session.create ===\n');
  const session = await request('session.create', {
    projectRoot: PROJECT_ROOT,
    ...(MODEL ? { model: MODEL } : {}),
    name: 'protocol-test',
    maxInputTokens: 200_000,
  });
  const sessionId = session.sessionId;

  console.log('\n=== 4. usage.get (before any turn) ===\n');
  console.log('  ', JSON.stringify(await request('usage.get', { sessionId })));

  console.log('\n=== 5. turn.send — streams events, may ask for approval ===\n');
  await request('turn.send', { sessionId, message: TASK });
  await finished;

  console.log('\n=== 6. session.history ===\n');
  const hist = await request('session.history', { sessionId });
  console.log(`  ${hist.messages.length} messages retained`);

  console.log('\n=== 7. usage.get (after) ===\n');
  console.log('  ', JSON.stringify(await request('usage.get', { sessionId })));

  console.log('\n=== 8. session.list ===\n');
  const list = await request('session.list', {});
  console.log(`  ${list.sessions.length} session(s):`, list.sessions.map(s => `${s.name}/${s.sessionId.slice(0, 8)}`).join(', '));

  console.log('\n=== 9. error handling — unknown method + bad session ===\n');
  for (const [m, p] of [['nope.nope', {}], ['usage.get', { sessionId: 'does-not-exist' }]]) {
    try { await request(m, p); } catch (e) { console.log('  rejected as expected:', e.message); }
  }

  console.log('\n=== 10. session.destroy ===\n');
  console.log('  ', JSON.stringify(await request('session.destroy', { sessionId })));

  child.stdin.end();
  setTimeout(() => process.exit(0), 200);
})().catch(e => {
  console.error('\nFATAL:', e.message);
  child.kill();
  process.exit(1);
});
