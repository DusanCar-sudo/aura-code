#!/usr/bin/env node
/**
 * Gazelle blind eval — harness.
 *
 * Gazelle's headline number is a TOKEN measurement (26x fewer per turn) with no
 * quality comparison beside it. A cheaper path that answers worse is not a win,
 * and right now nothing in this repo could tell the difference. This harness
 * produces the missing half.
 *
 * What it does:
 *   1. Runs every prompt through BOTH paths — the lean Gazelle conversational
 *      path and the full coder agent loop — recording answer and exact tokens.
 *   2. Writes a paired record per prompt.
 *   3. Writes a SHUFFLED, LABEL-STRIPPED scoring file: each pair becomes
 *      "A" and "B" in random order, with nothing indicating which path is which.
 *
 * Scoring is deliberately a separate step (score.mjs) so whoever scores — a
 * human or a third model — physically cannot see the labels. The key mapping is
 * written to a separate file that the scorer never reads.
 *
 * Usage:
 *   node benchmark/gazelle-eval/run.mjs                 # all 50 prompts
 *   node benchmark/gazelle-eval/run.mjs --limit 5       # smoke run
 *   node benchmark/gazelle-eval/run.mjs --only f01,a03
 *   node benchmark/gazelle-eval/run.mjs --model gemini/gemini-3.6-flash
 *
 * Both paths run on the SAME model, by design: this measures the path, not the
 * model. Comparing a small model on one path with a large one on the other
 * would answer a different question than the one asked.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO = resolve(__dirname, '..', '..');
const DIST = join(REPO, 'dist');
const RESULTS = join(__dirname, 'results');

if (!existsSync(DIST)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

const { createProvider } = require(join(DIST, 'providers', 'factory.js'));
const { createGazelleChat } = require(join(DIST, 'agent', 'gazelle-chat.js'));
const { runAgentLoop } = require(join(DIST, 'agent', 'loop.js'));
const { loadProjectContext } = require(join(DIST, 'agent', 'context.js'));
const { PermissionSystem } = require(join(DIST, 'safety', 'permissions.js'));

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const limit = Number(argOf('--limit', '0')) || 0;
const only = (argOf('--only', '') || '').split(',').filter(Boolean);
const model = argOf('--model', process.env.AURA_MODEL || 'gemini/gemini-3.6-flash');
const maxTurns = Number(argOf('--max-turns', '6'));
const rebuildFrom = argOf('--rebuild-sheet', '');

/**
 * A run that hit the turn cap did not answer — it was truncated by a harness
 * setting. Scoring "Loop ended after 6 turns" against a real answer would
 * credit the other path for this harness's arbitrary limit, so such pairs are
 * excluded from the blind sheet and reported instead of silently scored.
 */
function truncatedByCap(side) {
  return /^Loop ended after \d+ turns/.test((side.text ?? '').trim());
}
function scoreable(pair) {
  return Boolean(pair.gazelle.text.trim()) && Boolean(pair.coder.text.trim())
    && !truncatedByCap(pair.gazelle) && !truncatedByCap(pair.coder);
}

// ── a display that says nothing ──────────────────────────────────────────────
// The harness must not print model output as it streams: a scorer reading the
// terminal would see which path produced what, defeating the blinding.
const silent = new Proxy({}, { get: () => () => {} });

/** Deterministic shuffle so a run can be reproduced from its seed. */
function shuffle(items, seed) {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function runGazelle(prompt) {
  const chat = createGazelleChat({ provider: createProvider({ model }), display: silent });
  const started = Date.now();
  const turn = await chat.respond(prompt);
  return {
    text: turn.text ?? '',
    inputTokens: turn.inputTokens ?? 0,
    outputTokens: turn.outputTokens ?? 0,
    failed: Boolean(turn.failed),
    // Gazelle offering to escalate is a legitimate answer to an ambiguous ask,
    // not a failure — recorded so scoring can account for it.
    offeredEscalation: Boolean(turn.needsTools),
    wallMs: Date.now() - started,
  };
}

async function runCoder(prompt, context) {
  const started = Date.now();
  try {
    const result = await runAgentLoop({
      provider: createProvider({ model }),
      task: prompt,
      context,
      // read-only: a conversational prompt must never mutate the repo the
      // harness is running inside.
      permissions: new PermissionSystem('read-only'),
      display: silent,
      maxTurns,
      disableSpawn: true,
      skipInspector: true,
    });
    return {
      text: result.summary ?? '',
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      failed: !result.success,
      toolCalls: result.toolCallCount ?? 0,
      turns: result.turns ?? 0,
      wallMs: Date.now() - started,
    };
  } catch (e) {
    return {
      text: '', inputTokens: 0, outputTokens: 0, failed: true,
      error: String(e), wallMs: Date.now() - started,
    };
  }
}

async function main() {
  if (rebuildFrom) return rebuildSheet(rebuildFrom);
  const spec = JSON.parse(readFileSync(join(__dirname, 'prompts.json'), 'utf8'));
  let prompts = spec.prompts;
  if (only.length > 0) prompts = prompts.filter(p => only.includes(p.id));
  if (limit > 0) prompts = prompts.slice(0, limit);

  mkdirSync(RESULTS, { recursive: true });
  const context = await loadProjectContext(REPO);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const seed = Date.now() & 0x7fffffff;

  console.log(`Gazelle blind eval — ${prompts.length} prompt(s), model ${model}`);
  console.log('Both paths run the same model; this measures the path, not the model.\n');

  const pairs = [];
  for (const [i, p] of prompts.entries()) {
    process.stdout.write(`  [${String(i + 1).padStart(2)}/${prompts.length}] ${p.id} ${p.category.padEnd(9)} `);
    const gazelle = await runGazelle(p.text);
    const coder = await runCoder(p.text, context);
    const gTok = gazelle.inputTokens + gazelle.outputTokens;
    const cTok = coder.inputTokens + coder.outputTokens;
    const ratio = gTok > 0 ? (cTok / gTok).toFixed(1) : 'n/a';
    console.log(
      `gazelle ${String(gTok).padStart(6)} tok | coder ${String(cTok).padStart(7)} tok | ${ratio}x`
      + (gazelle.failed ? ' [gazelle FAILED]' : '')
      + (coder.failed ? ' [coder FAILED]' : ''),
    );
    pairs.push({ prompt: p, gazelle, coder });
  }

  // ── full record, labels intact — for analysis, NOT for the scorer ─────────
  const recordFile = join(RESULTS, `run-${stamp}.json`);
  writeFileSync(recordFile, JSON.stringify({ model, seed, stamp, pairs }, null, 2) + '\n');

  // ── blind scoring sheet: shuffled, labels stripped ────────────────────────
  const key = [];
  const excluded = pairs.filter(p => !scoreable(p));
  const sheet = pairs
    .filter(scoreable)
    .map(({ prompt, gazelle, coder }, idx) => {
      // Independent coin flip per pair, so a scorer cannot learn "A is always X".
      const gazelleFirst = shuffle([true, false], seed + idx)[0];
      const A = gazelleFirst ? gazelle : coder;
      const B = gazelleFirst ? coder : gazelle;
      key.push({ id: prompt.id, A: gazelleFirst ? 'gazelle' : 'coder', B: gazelleFirst ? 'coder' : 'gazelle' });
      return { id: prompt.id, category: prompt.category, prompt: prompt.text, A: A.text, B: B.text };
    });

  if (excluded.length > 0) {
    console.log(`\n  ${excluded.length} pair(s) excluded from scoring (no usable answer from one side):`);
    for (const e of excluded) {
      const why = truncatedByCap(e.coder) ? 'coder hit the turn cap'
        : truncatedByCap(e.gazelle) ? 'gazelle hit the turn cap'
        : !e.gazelle.text.trim() ? 'gazelle produced no text' : 'coder produced no text';
      console.log(`    ${e.prompt.id} (${e.prompt.category}) — ${why}`);
    }
    console.log('    Re-run these with a higher --max-turns rather than scoring a truncation.');
  }

  const sheetFile = join(RESULTS, `sheet-${stamp}.json`);
  const keyFile = join(RESULTS, `key-${stamp}.json`);
  writeFileSync(sheetFile, JSON.stringify({ stamp, items: shuffle(sheet, seed) }, null, 2) + '\n');
  writeFileSync(keyFile, JSON.stringify({ stamp, key }, null, 2) + '\n');

  // ── token summary — the half that already existed ────────────────────────
  const sum = (f) => pairs.reduce((n, p) => n + f(p), 0);
  const gTotal = sum(p => p.gazelle.inputTokens + p.gazelle.outputTokens);
  const cTotal = sum(p => p.coder.inputTokens + p.coder.outputTokens);
  console.log('\n── Tokens ───────────────────────────────────────');
  console.log(`  gazelle: ${gTotal.toLocaleString()}`);
  console.log(`  coder:   ${cTotal.toLocaleString()}`);
  console.log(`  ratio:   ${gTotal > 0 ? (cTotal / gTotal).toFixed(1) : 'n/a'}x fewer on the gazelle path`);
  console.log(`\n  record: ${recordFile}`);
  console.log(`  sheet:  ${sheetFile}   ← give this to the scorer`);
  console.log(`  key:    ${keyFile}   ← the scorer must NOT see this`);
  console.log('\nNext: node benchmark/gazelle-eval/score.mjs --sheet <sheet> [--judge <model>]');
}

/**
 * Rebuild a blind sheet from one or more existing records, applying the current
 * exclusion rule. No API calls — used after fixing a methodological problem so
 * the runs already paid for are not thrown away.
 */
function rebuildSheet(recordPaths) {
  const files = recordPaths.split(',').map(f => f.trim()).filter(Boolean);
  const pairs = [];
  let model = '';
  for (const f of files) {
    const rec = JSON.parse(readFileSync(f, 'utf8'));
    model = rec.model;
    for (const p of rec.pairs) {
      // A later record wins for the same prompt id (a re-run supersedes).
      const at = pairs.findIndex(x => x.prompt.id === p.prompt.id);
      if (at >= 0) pairs[at] = p; else pairs.push(p);
    }
  }
  const excluded = pairs.filter(p => !scoreable(p));
  const kept = pairs.filter(scoreable);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const seed = 20260828;
  const key = [];
  const sheet = kept.map(({ prompt, gazelle, coder }, idx) => {
    const gazelleFirst = shuffle([true, false], seed + idx)[0];
    const A = gazelleFirst ? gazelle : coder;
    const B = gazelleFirst ? coder : gazelle;
    key.push({ id: prompt.id, A: gazelleFirst ? 'gazelle' : 'coder', B: gazelleFirst ? 'coder' : 'gazelle' });
    return { id: prompt.id, category: prompt.category, prompt: prompt.text, A: A.text, B: B.text };
  });
  writeFileSync(join(RESULTS, `run-${stamp}.json`), JSON.stringify({ model, seed, stamp, pairs }, null, 2) + '\n');
  writeFileSync(join(RESULTS, `sheet-${stamp}.json`), JSON.stringify({ stamp, items: shuffle(sheet, seed) }, null, 2) + '\n');
  writeFileSync(join(RESULTS, `key-${stamp}.json`), JSON.stringify({ stamp, key }, null, 2) + '\n');
  console.log(`Rebuilt from ${files.length} record(s): ${pairs.length} pair(s), ${kept.length} scoreable, ${excluded.length} excluded.`);
  for (const e of excluded) console.log(`  excluded ${e.prompt.id} (${e.prompt.category})`);
  console.log(`\n  sheet: ${join(RESULTS, `sheet-${stamp}.json`)}`);
}

void main();
