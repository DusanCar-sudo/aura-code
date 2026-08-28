#!/usr/bin/env node
/**
 * Gazelle blind eval — scoring.
 *
 * Reads a label-stripped sheet produced by run.mjs and scores each A/B pair for
 * helpfulness and correctness. Two modes:
 *
 *   --judge <model>   a third model scores. It is told nothing about which path
 *                     produced which answer, or that two paths exist at all.
 *   (default)         interactive: pairs are printed for a human to score.
 *
 * The key file is read ONLY at the end, to attribute scores back to paths. Until
 * that moment nothing in this process knows which answer came from where — which
 * is the property that makes the result worth anything.
 *
 * Usage:
 *   node benchmark/gazelle-eval/score.mjs --sheet results/sheet-<stamp>.json
 *   node benchmark/gazelle-eval/score.mjs --sheet <f> --judge gemini/gemini-3.6-flash
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as readline from 'node:readline/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const DIST = join(resolve(__dirname, '..', '..'), 'dist');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const sheetPath = argOf('--sheet', '');
const judge = argOf('--judge', '');

if (!sheetPath || !existsSync(sheetPath)) {
  console.error('Pass --sheet results/sheet-<stamp>.json (produced by run.mjs).');
  process.exit(1);
}

const RUBRIC = `You are comparing two answers to the same question.

Score each answer 1-5 on two axes:
  helpfulness — does it actually serve the person who asked?
  correctness — is it accurate, and does it avoid stating things that are false?

An answer that honestly says it cannot know something without looking is NOT
incorrect; an answer that invents specifics is. Length is not quality.

Reply with ONLY a JSON object, no prose:
{"A":{"helpfulness":N,"correctness":N},"B":{"helpfulness":N,"correctness":N},"note":"one short sentence"}`;

async function scoreWithModel(items, model) {
  const { createProvider } = require(join(DIST, 'providers', 'factory.js'));
  const provider = createProvider({ model });
  const scores = [];
  for (const [i, item] of items.entries()) {
    const prompt = [
      `Question: ${item.prompt}`, '',
      `Answer A:\n${item.A}`, '',
      `Answer B:\n${item.B}`,
    ].join('\n');
    process.stdout.write(`  [${i + 1}/${items.length}] ${item.id} … `);
    try {
      const res = await provider.complete(RUBRIC, [{ role: 'user', content: prompt }], []);
      const match = res.text.match(/\{[\s\S]*\}/);
      if (!match) { console.log('unparseable'); continue; }
      const parsed = JSON.parse(match[0]);
      scores.push({ id: item.id, category: item.category, ...parsed });
      console.log(`A ${parsed.A.helpfulness}/${parsed.A.correctness}  B ${parsed.B.helpfulness}/${parsed.B.correctness}`);
    } catch (e) {
      console.log(`error: ${String(e).slice(0, 60)}`);
    }
  }
  return scores;
}

async function scoreInteractively(items) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const scores = [];
  console.log('\nScore each answer 1-5 for helpfulness and correctness.');
  console.log('Enter as: <A-help> <A-correct> <B-help> <B-correct>   (blank to skip)\n');
  for (const [i, item] of items.entries()) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`[${i + 1}/${items.length}]  ${item.prompt}\n`);
    console.log(`── A ──\n${item.A}\n`);
    console.log(`── B ──\n${item.B}\n`);
    const line = (await rl.question('scores> ')).trim();
    if (!line) continue;
    const [ah, ac, bh, bc] = line.split(/\s+/).map(Number);
    if ([ah, ac, bh, bc].some(n => !Number.isFinite(n))) { console.log('skipped (unparseable)'); continue; }
    scores.push({
      id: item.id, category: item.category,
      A: { helpfulness: ah, correctness: ac },
      B: { helpfulness: bh, correctness: bc },
    });
  }
  rl.close();
  return scores;
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

async function main() {
  const sheet = JSON.parse(readFileSync(sheetPath, 'utf8'));
  const items = sheet.items;
  console.log(`Blind scoring ${items.length} pair(s) — ${judge ? `judge model ${judge}` : 'interactive'}`);
  console.log('Nothing in this step knows which path produced A or B.\n');

  const scores = judge ? await scoreWithModel(items, judge) : await scoreInteractively(items);
  if (scores.length === 0) { console.log('\nNo scores recorded.'); return; }

  // ── unblind, only now ────────────────────────────────────────────────────
  const keyPath = sheetPath.replace(basename(sheetPath), basename(sheetPath).replace('sheet-', 'key-'));
  if (!existsSync(keyPath)) { console.error(`\nKey not found beside the sheet: ${keyPath}`); process.exit(1); }
  const key = JSON.parse(readFileSync(keyPath, 'utf8')).key;
  const byId = new Map(key.map(k => [k.id, k]));

  const byPath = { gazelle: { helpfulness: [], correctness: [] }, coder: { helpfulness: [], correctness: [] } };
  for (const s of scores) {
    const k = byId.get(s.id);
    if (!k) continue;
    byPath[k.A].helpfulness.push(s.A.helpfulness);
    byPath[k.A].correctness.push(s.A.correctness);
    byPath[k.B].helpfulness.push(s.B.helpfulness);
    byPath[k.B].correctness.push(s.B.correctness);
  }

  // ── token difference, reported alongside — never on its own ──────────────
  const recordPath = sheetPath.replace('sheet-', 'run-');
  let tokenLine = '  (token record not found beside the sheet)';
  if (existsSync(recordPath)) {
    const rec = JSON.parse(readFileSync(recordPath, 'utf8'));
    const g = rec.pairs.reduce((n, p) => n + p.gazelle.inputTokens + p.gazelle.outputTokens, 0);
    const c = rec.pairs.reduce((n, p) => n + p.coder.inputTokens + p.coder.outputTokens, 0);
    tokenLine = `  gazelle ${g.toLocaleString()} tok vs coder ${c.toLocaleString()} tok`
      + `  (${g > 0 ? (c / g).toFixed(1) : 'n/a'}x fewer)`;
  }

  const gh = mean(byPath.gazelle.helpfulness), gc = mean(byPath.gazelle.correctness);
  const ch = mean(byPath.coder.helpfulness), cc = mean(byPath.coder.correctness);

  console.log(`\n${'═'.repeat(70)}`);
  console.log('Blind eval result');
  console.log(`${'═'.repeat(70)}`);
  console.log(`  n = ${scores.length} scored pair(s)\n`);
  console.log('  path      helpfulness  correctness');
  console.log(`  gazelle   ${gh.toFixed(2).padStart(11)}  ${gc.toFixed(2).padStart(11)}`);
  console.log(`  coder     ${ch.toFixed(2).padStart(11)}  ${cc.toFixed(2).padStart(11)}`);
  console.log(`  delta     ${(gh - ch >= 0 ? '+' : '') + (gh - ch).toFixed(2).padStart(10)}  ${(gc - cc >= 0 ? '+' : '') + (gc - cc).toFixed(2).padStart(10)}`);
  console.log('\n── Token difference, for reading beside the scores ──');
  console.log(tokenLine);
  console.log('\n  A negative delta is the finding, not a failure of the harness.');
  console.log('  Report both numbers together: a cheaper path that answers worse is not a win.');

  const out = sheetPath.replace('sheet-', 'scores-');
  writeFileSync(out, JSON.stringify({
    scoredBy: judge || 'human', n: scores.length,
    gazelle: { helpfulness: gh, correctness: gc },
    coder: { helpfulness: ch, correctness: cc },
    scores,
  }, null, 2) + '\n');
  console.log(`\n  scores: ${out}`);
}

void main();
