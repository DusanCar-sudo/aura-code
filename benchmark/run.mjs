#!/usr/bin/env node
/**
 * Aura benchmark harness.
 *
 * Reproducibility contract:
 *   - Each task's "before/" fixture is copied fresh into a temp dir every run —
 *     never mutated in place, never reused across runs.
 *   - The task prompt, verify command, and starting file state are fixed and
 *     versioned in task.json — same inputs every time, by construction.
 *   - Nothing here scores "did it run" — only "did the verify command pass",
 *     which should be a real test suite, not a smoke check.
 *
 * Usage:
 *   node benchmark/run.mjs                # run all fixtures
 *   node benchmark/run.mjs task-001        # run fixtures matching a prefix
 *   node benchmark/run.mjs --dry-run       # copy fixtures, skip aura + verify
 *   node benchmark/run.mjs --runs 3        # repeat each task N times (variance)
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');
const RESULTS_DIR = join(__dirname, 'results');
// Local disk, not system /tmp — tmpfs is RAM-backed and can run out of
// quota under memory pressure, which looks like a harness bug but isn't.
const SCRATCH_DIR = join(__dirname, '.bench-tmp');
mkdirSync(SCRATCH_DIR, { recursive: true });
const AURA_TIMEOUT_MS = 5 * 60 * 1000; // 5 min ceiling per task

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const runsIdx = args.indexOf('--runs');
const runsPerTask = runsIdx !== -1 ? parseInt(args[runsIdx + 1], 10) : 1;
const filterArgs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs');

function loadFixtures() {
  if (!existsSync(FIXTURES_DIR)) {
    console.error(`✗ No fixtures directory at ${FIXTURES_DIR}`);
    process.exit(1);
  }
  let dirs = readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  if (filterArgs.length > 0) {
    dirs = dirs.filter((name) => filterArgs.some((f) => name.startsWith(f)));
  }
  return dirs;
}

function runOneTask(taskName) {
  const fixtureDir = join(FIXTURES_DIR, taskName);
  const taskJsonPath = join(fixtureDir, 'task.json');
  const beforeDir = join(fixtureDir, 'before');

  if (!existsSync(taskJsonPath)) {
    return { taskName, error: `missing task.json` };
  }
  if (!existsSync(beforeDir)) {
    return { taskName, error: `missing before/ fixture` };
  }

  const task = JSON.parse(readFileSync(taskJsonPath, 'utf8'));
  const workDir = mkdtempSync(join(SCRATCH_DIR, `${taskName}-`));

  try {
    execSync(`cp -r "${beforeDir}/." "${workDir}/"`, { stdio: 'pipe' });

    if (dryRun) {
      return { taskName, dryRun: true, workDir, prompt: task.prompt };
    }

    const start = Date.now();
    const auraResult = spawnSync('aura', ['--auto', task.prompt], {
      cwd: workDir,
      timeout: AURA_TIMEOUT_MS,
      encoding: 'utf8',
      shell: false,
    });
    const durationMs = Date.now() - start;

    if (auraResult.error) {
      return { taskName, error: `aura invocation failed: ${auraResult.error.message}`, workDir };
    }

    const verifyResult = spawnSync('sh', ['-c', task.verify], {
      cwd: workDir,
      timeout: 60_000,
      encoding: 'utf8',
    });

    const episodeCount = countEpisodes(workDir);

    return {
      taskName,
      durationMs,
      auraExitCode: auraResult.status,
      verifyExitCode: verifyResult.status,
      verifyPass: verifyResult.status === 0,
      episodeCount,
      auraStdoutTail: tail(auraResult.stdout, 40),
      verifyOutputTail: tail(verifyResult.stdout + verifyResult.stderr, 40),
      workDir,
    };
  } catch (err) {
    return { taskName, error: err.message, workDir };
  }
}

function countEpisodes(workDir) {
  const episodesDir = join(workDir, 'episodes');
  if (!existsSync(episodesDir)) return 0;
  try {
    return readdirSync(episodesDir).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function tail(str, lines) {
  if (!str) return '';
  return str.split('\n').slice(-lines).join('\n');
}

function main() {
  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    console.error('✗ No matching fixtures found.');
    process.exit(1);
  }

  console.log(`Running ${fixtures.length} fixture(s) × ${runsPerTask} run(s)${dryRun ? ' [DRY RUN]' : ''}\n`);

  const allResults = [];
  for (const taskName of fixtures) {
    for (let run = 1; run <= runsPerTask; run++) {
      const label = runsPerTask > 1 ? `${taskName} (run ${run}/${runsPerTask})` : taskName;
      process.stdout.write(`→ ${label}... `);
      const result = runOneTask(taskName);
      result.run = run;
      allResults.push(result);

      if (result.error) {
        console.log(`✗ ERROR: ${result.error}`);
      } else if (result.dryRun) {
        console.log(`✓ fixture copied to ${result.workDir}`);
      } else {
        const status = result.verifyPass ? '✓ PASS' : '✗ FAIL';
        console.log(`${status}  ${(result.durationMs / 1000).toFixed(1)}s  ${result.episodeCount} episode(s)`);
      }
    }
  }

  if (!dryRun) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = join(RESULTS_DIR, `${stamp}.json`);
    writeFileSync(outPath, JSON.stringify(allResults, null, 2));
    console.log(`\nResults written to ${outPath}`);
    printSummary(allResults);
  }
}

function printSummary(results) {
  const valid = results.filter((r) => !r.error && !r.dryRun);
  if (valid.length === 0) return;

  const passed = valid.filter((r) => r.verifyPass).length;
  const avgMs = valid.reduce((sum, r) => sum + r.durationMs, 0) / valid.length;

  console.log('\n--- Summary ---');
  console.log(`Pass rate:      ${passed}/${valid.length} (${((passed / valid.length) * 100).toFixed(0)}%)`);
  console.log(`Avg duration:   ${(avgMs / 1000).toFixed(1)}s`);
}

main();
