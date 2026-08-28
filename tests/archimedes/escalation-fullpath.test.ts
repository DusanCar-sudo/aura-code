/**
 * Escalation-correctness benchmark — FULL ARCHIMEDES PATH (Task 3 of the repair
 * plan). This is the measurement the plan actually asks for.
 *
 * The verifier-only harness (escalation-correctness.test.ts) grades the
 * VERIFIER in isolation by feeding it both planted answers. That tells you how
 * good the grade is; it cannot tell you what the small model actually produces
 * inside a real agent loop, nor how many tokens each case costs.
 *
 * This harness runs each of the same 30 cases through the real, production
 * Archimedes path:
 *
 *   ArchimedesAlternator.run(task)
 *     -> competence gate (bypassed via forceArchimedes: true — the set measures
 *        the small model + verifier decision, not the gate)
 *     -> small model agent loop (Ollama gemma-archimedes-gen2-v2, read-only
 *        tools, real file reads against a fixture project)
 *     -> verifyArchimedesAnswer (real DeepSeek verifier)
 *     -> escalation to the large model only when the verifier rejects
 *
 * Classification per plan (measured on the small model's ACTUAL answer):
 *   - correct-routing  : answer correct AND accepted, or answer wrong AND rejected
 *   - false-escalation : answer correct but verifier said INVALID (we paid twice)
 *   - missed-escalation: answer wrong but verifier said VALID (we ship garbage) ← PRIMARY
 *   - both-wrong       : answer correct but rejected AND answer wrong but accepted
 *                        (verifier fully backwards — only possible in the
 *                        verifier-only harness; in the full path each case has
 *                        one answer, so this bucket cannot occur and the plan's
 *                        four states collapse to three)
 *   - small-no-answer  : the small model produced nothing usable — the verifier
 *                        never ran. Reported separately: it is a small-model
 *                        failure, not a verifier error, and must not be counted
 *                        as either escalation class.
 *
 * Grading is deterministic: each case declares regex facts (must / mustAny /
 * mustNot) extracted from the known-correct answer. The small model's answer is
 * graded by matching those facts, NOT by another LLM — so the grade is stable
 * across runs and cannot drift with the grader.
 *
 * Token cost per case: read from the isolated cost ledger (AURA_COST_LOG_DIR)
 * appended by the alternator itself, one JSONL row per run.
 *
 * Live requirements: Ollama serving gemma-archimedes-gen2-v2 at 11434 and
 * DEEPSEEK_API_KEY in the environment. Both checks run in beforeAll and the
 * suite skips loudly with a reason when either is missing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ArchimedesAlternator } from '../../src/archimedes/alternator.js';
import { loadProjectContext } from '../../src/agent/context.js';
import { createResilientProvider } from '../../src/providers/resilient-factory.js';
import type { LLMProvider } from '../../src/providers/types.js';
import { loadCostLogs } from '../../src/archimedes/cost-log.js';
import { CASES, type EscalationCase } from './escalation-cases.js';

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic grade facts, keyed by case id
// ─────────────────────────────────────────────────────────────────────────────
//
// must      — every regex must match the small model's answer (case-insensitive, word search)
// mustAny   — at least one must match (for answers with several acceptable phrasings)
// mustNot   — none may match (wrong answers contain these; the correct ones don't)
//
// These are derived from each case's known-correct answer and its wrong answer.

interface GradeFacts {
  must?: RegExp[];
  mustAny?: RegExp[];
  mustNot?: RegExp[];
}

const GRADES: Record<string, GradeFacts> = {
  // ── RETRIEVAL ──────────────────────────────────────────────────────────
  'ret-001-exists': {
    must: [/\b5\b/i, /max_retries/i],
    mustNot: [/10\b/, /settings\.js/i],
  },
  'ret-002-not-found': {
    must: [/no\b/i, /getconnectionpool/i],
    mustNot: [/yes\b/i, /defined\b/i, /manages\b/i],
  },
  'ret-003-contradiction': {
    must: [/\b3000\b/i, /port/i],
    mustNot: [/8080/],
  },
  'ret-004-interface': {
    must: [/login/i, /logout/i, /refresh/i],
    mustNot: [/register|verify|revoke/i],
  },
  'ret-005-version': {
    must: [/node/i, />=\s*18[. ]/i],
    mustNot: [/16[. ]/],
  },
  'ret-006-plural': {
    must: [/\b3\b/i],
    mustNot: [/\b5\b/],
  },
  'ret-007-export': {
    must: [/yes\b/i, /exported/i, /processorder/i],
    mustNot: [/private\b|not\s+exported/i],
  },
  'ret-008-flag': {
    must: [/no\b/i, /false\b/i, /enable_billing/i],
    mustNot: [/yes\b/i, /enabled by default/i],
  },
  'ret-009-route': {
    must: [/\bhealth\b/i],
    mustNot: [/status/i],
  },
  'ret-010-constant-file': {
    must: [/default_timeout/i, /src\/utils\/timeout\.ts/i],
    mustNot: [/core\/constants/i],
  },
  'ret-011-missing-method': {
    must: [/no\b/i, /findbyid/i],
    mustNot: [/yes\b/i, /retrieves\b/i, /method\b/i],
  },
  'ret-012-script': {
    must: [/\btsc\b/i],
    mustNot: [/vitest/i],
  },
  'ret-013-definition': {
    must: [/paymentgateway/i, /gateway\.ts/i],
    mustNot: [/shared\/types/i],
  },
  'ret-014-count': {
    must: [/\b3\b/i, /express|zod|dotenv/i],
    mustNot: [/\b7\b/],
  },
  'ret-015-env': {
    must: [/database_url/i],
    mustNot: [/db_host/i],
  },
  // ── DESIGN ─────────────────────────────────────────────────────────────
  'des-001-feature': {
    must: [/limit|offset|page/i, /pagination/i],
    mustNot: [/graph database/i, /denormaliz/i],
  },
  'des-002-refactor': {
    must: [/schema/i, /shared\b|extract|reuse|single/i],
    mustNot: [/duplication.*safer|independent copies|keep the duplication/i],
  },
  'des-003-architecture': {
    mustAny: [/redis|ttl|cache-control|etag|invalidate/i],
    mustNot: [/cache nothing/i],
  },
  'des-004-auth': {
    must: [/refresh token/i, /rotate|rotat/i],
    mustNot: [/localstorage/i, /never expire/i],
  },
  'des-005-monitoring': {
    mustAny: [/heartbeat/i, /health\b/i, /metrics/i, /alert/i],
    mustNot: [/console\.log/i],
  },
  'des-006-error-handling': {
    must: [/middleware|central/i, /json|status|codes?/i],
    mustNot: [/stack trace/i, /raw stack/i],
  },
  'des-007-db-migration': {
    must: [/expand|contract|nullable|backfill/i],
    mustNot: [/drop the table|drop\s+.*recreate/i],
  },
  'des-008-logging': {
    must: [/structured|pino|winston|json/i, /correlation|level/i],
    mustNot: [/more console\.log/i],
  },
  'des-009-rate-limiting': {
    must: [/sliding|token bucket|rate limit|429|retry-after|per-route/i],
    mustNot: [/block all unauthenticated|require users to authenticate/i],
  },
  'des-010-testing': {
    must: [/unit|integration|property/i],
    mustNot: [/skip tests|after launch/i],
  },
  'des-011-config': {
    must: [/env(ironment)?/i, /schema|zod|validate|default|fail.?fast/i],
    mustNot: [/single json file committed/i],
  },
  'des-012-microservices': {
    must: [/not yet|module|interface|200 lines|revisit/i],
    mustNot: [/microservices are always better|split it out now/i],
  },
  'des-013-cache-key': {
    must: [/user:.*:profile|namespac|:v\d|ttl/i],
    mustNot: [/email as the cache key/i],
  },
  'des-014-retry': {
    must: [/exponential|backoff|jitter|idempoten|max retr/i],
    mustNot: [/tight loop|retry immediately 10/i],
  },
  'des-015-security': {
    must: [/env(ironment)?|secret|rotate|never commit/i],
    mustNot: [/\.env file committed/i],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixture project — built deterministically from the cases' evidence
// ─────────────────────────────────────────────────────────────────────────────
//
// Each case's evidence is a recorded tool result. To run the real agent loop
// we need a real project where those tool results are true:
//   read_file    -> write the file, with the content
//   search_code  -> write the code line into the file at the stated path,
//                   OR (content "No results found") ensure the symbol does
//                   NOT appear anywhere
//   list_dir     -> create the directory and the listed entries

const FIXTURE_ROOT = path.resolve(
  fileURLToPath(new URL('../../benchmark/escalation/fixture-project', import.meta.url)),
);

function fixtureFromEvidence(): void {
  if (!fs.existsSync(FIXTURE_ROOT)) fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  for (const case_ of CASES) {
    for (const ev of case_.evidence) {
      const inputPath = String(ev.input.path ?? ev.input.query ?? '');
      const content = ev.content;
      if (ev.name === 'read_file' || ev.name === 'search_code') {
        // read_file: path -> write the file with 'content'.
        // search_code: content "src/x:line: code" -> write that code INTO src/x
        //              (the content names the file the symbol lives in);
        //              content "No results found..." -> the symbol is absent,
        //              so we write nothing for it (it stays absent).
        //              read_file evidence can point AT A DIRECTORY
        //              (des-012: path 'src/notifications/' describes a folder) —
        //              create the directory only.
        const filePath = ev.name === 'search_code'
          ? (content.match(/^([^\s:]+(?:\.\w+)?):\d+:/)?.[1] ?? '')
          : inputPath;
        if (!filePath) continue; // "No results found" — nothing to write
        const full = path.join(FIXTURE_ROOT, filePath);
        if (!full.startsWith(FIXTURE_ROOT)) continue; // no path traversal
        if (inputPath.endsWith('/')) {
          fs.mkdirSync(full, { recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        // Strip the "src/config.js:7: " prefix for search_code lines
        const code = content.replace(/^[^\s:]+:\d+:\s*/, '');
        fs.writeFileSync(full, code + '\n', 'utf8');
      } else if (ev.name === 'list_dir') {
        const dir = path.join(FIXTURE_ROOT, inputPath);
        fs.mkdirSync(dir, { recursive: true });
        for (const line of content.split('\n').slice(1)) {
          const name = line.trim().replace(/^[│├└─\s]+/, '').replace(/\/$/, '');
          if (!name) continue;
          const p = path.join(dir, name);
          if (p.startsWith(dir) && !fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Isolated scratch dirs + live-endpoint probes
// ─────────────────────────────────────────────────────────────────────────────

let scratchRoot: string | null = null;
let oldEpisodesDir: string | undefined;
let oldCostLogDir: string | undefined;
let skipReason: string | null = null;
let largeModelProvider: LLMProvider | null = null;
let archimedesConfig: import('../../src/archimedes/types.js').ArchimedesConfig | null = null;
const results: Record<string, unknown> = {};

beforeAll(async () => {
  // Live-endpoint probes first (cheap, fail fast).
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    skipReason = 'DEEPSEEK_API_KEY not set — cannot run the real verifier';
    return;
  }
  try {
    const probe = await fetch('http://127.0.0.1:11434/v1/models', {
      headers: { Authorization: 'Bearer ollama' },
    });
    if (!probe.ok) throw new Error(`Ollama probe HTTP ${probe.status}`);
  } catch (e) {
    skipReason = `Ollama (gemma-archimedes) not reachable at 127.0.0.1:11434 — ${String(e)}`;
    return;
  }

  // Isolate state so the benchmark cannot pollute live data.
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-escalation-'));
  oldEpisodesDir = process.env.AURA_EPISODES_DIR;
  oldCostLogDir = process.env.AURA_COST_LOG_DIR;
  process.env.AURA_EPISODES_DIR = path.join(scratchRoot, 'episodes');
  process.env.AURA_COST_LOG_DIR = path.join(scratchRoot, 'cost-log');

  fixtureFromEvidence();

  try {
    largeModelProvider = createResilientProvider(
      { model: 'deepseek-chat', apiKey },
      { maxRetries: 1 },
    );
    archimedesConfig = {
      modelName: 'gemma-archimedes-gen2-v2:latest',
      ollamaBaseUrl: 'http://127.0.0.1:11434/v1',
      competenceThreshold: 0.7,
      minAttempts: 3,
      enabled: true,
      epsilonProbeRate: 0.05,
    };
  } catch (e) {
    skipReason = `failed to init providers: ${String(e)}`;
  }
});

afterAll(() => {
  if (oldEpisodesDir !== undefined) process.env.AURA_EPISODES_DIR = oldEpisodesDir;
  else delete process.env.AURA_EPISODES_DIR;
  if (oldCostLogDir !== undefined) process.env.AURA_COST_LOG_DIR = oldCostLogDir;
  else delete process.env.AURA_COST_LOG_DIR;
  largeModelProvider = null;
  archimedesConfig = null;
  // leave scratchRoot for inspection — results reference it
});

// ─────────────────────────────────────────────────────────────────────────────
// Grading — deterministic fact match
// ─────────────────────────────────────────────────────────────────────────────

function matchesAll(answer: string, re: RegExp[]): boolean {
  return re.every((r) => {
    r.lastIndex = 0;
    return r.test(answer);
  });
}

function matchesAny(answer: string, re: RegExp[]): boolean {
  return re.some((r) => {
    r.lastIndex = 0;
    return r.test(answer);
  });
}

function gradeAnswer(answer: string, case_: EscalationCase): { correct: boolean | null; why: string } {
  const g = GRADES[case_.id];
  if (!g) throw new Error(`no grade facts for case ${case_.id}`);
  if (g.must && !matchesAll(answer, g.must)) {
    const failed = (g.must ?? []).filter((r) => { r.lastIndex = 0; return !r.test(answer); });
    return { correct: false, why: `missing: ${failed.map((r) => String(r)).join(', ')}` };
  }
  if (g.mustAny && !matchesAny(answer, g.mustAny)) {
    return { correct: false, why: `missing any of: ${g.mustAny.map((r) => String(r)).join(', ')}` };
  }
  if (g.mustNot) {
    const bad = g.mustNot.filter((r) => { r.lastIndex = 0; return r.test(answer); });
    if (bad.length > 0) {
      return { correct: false, why: `contains forbidden: ${bad.map((r) => String(r)).join(', ')}` };
    }
  }
  return { correct: true, why: 'all grade facts matched' };
}

// ─────────────────────────────────────────────────────────────────────────────
// The benchmark itself
// ─────────────────────────────────────────────────────────────────────────────

function shapeAnswer(raw: string): string {
  // The gemma thinking model wraps output in  thinking...<｜end▁of▁thinking｜> tags; the
  // alternator's `summary` may carry the full artifact. Grade the CLEANED text
  // (strip a leading/trailing thinking block) so the grade sees the answer,
  // not the model's internal monologue.
  let t = raw?.trim() ?? '';
  const thinkMatch = t.match(/<thinking>([\s\S]*?)<\/thinking>\s*/i);
  if (thinkMatch) t = t.slice(thinkMatch[0].length);
  t = t.replace(/^\s*<thinking>[\s\S]*?<\/thinking>\s*/i, '');
  return t.trim().slice(0, 4000);
}

/** Runs one case through the full production path and records outcome. */
async function runOneCase(case_: EscalationCase): Promise<void> {
  const provider = largeModelProvider;
  const config = archimedesConfig;
  if (!provider || !config) throw new Error('not initialized');

  const context = await loadProjectContext(FIXTURE_ROOT);
  const alternator = new ArchimedesAlternator({
    archimedesConfig: config,
    largeModelProvider: provider,
    projectRoot: FIXTURE_ROOT,
    context,
    forceArchimedes: true, // bypass the competence gate — we measure small model + verifier
    maxTurns: 10,
  });
  const run = await alternator.run(case_.task);
  const ep = run.episode;

  const smallAnswer = ep.archimedesOutput ?? '';
  const graded = smallAnswer.trim().length > 0
    ? gradeAnswer(shapeAnswer(smallAnswer), case_)
    : { correct: false, why: 'small model produced no answer' };

  let classification: string;
  if (smallAnswer.trim().length === 0) {
    classification = 'small-no-answer';
  } else if (graded.correct && ep.archimedesSucceeded) {
    classification = 'correct-routing'; // right answer, accepted
  } else if (graded.correct && !ep.archimedesSucceeded) {
    classification = 'false-escalation'; // right answer rejected — paid twice
  } else if (!graded.correct && !ep.archimedesSucceeded) {
    classification = 'correct-routing'; // wrong answer rejected — escalation worked
  } else {
    classification = 'missed-escalation'; // wrong answer accepted — PRIMARY
  }

  results[case_.id] = {
    id: case_.id,
    mode: case_.mode,
    shouldHandle: case_.shouldHandle,
    smallAnswer: smallAnswer.slice(0, 400),
    graded: graded,
    verifierVerdict: ep.archimedesSucceeded ? 'VALID' : 'INVALID',
    classification,
    tokens: {
      archimedes: ep.tokensUsed.archimedes ?? 0,
      largeModel: ep.tokensUsed.largeModel ?? 0,
    },
    durationMs: ep.durationMs,
    usedArchimedes: run.usedArchimedes,
  };
}

describe('Escalation-correctness — full Archimedes path', () => {
  it('has grade facts for all 30 cases', () => {
    for (const c of CASES) {
      expect(GRADES[c.id]).toBeDefined();
      const g = GRADES[c.id];
      // every case must have at least one positive requirement
      expect((g.must?.length ?? 0) + (g.mustAny?.length ?? 0)).toBeGreaterThan(0);
    }
  });

  it('runs all 30 cases through the full path', { timeout: 3_600_000 }, async () => {
    if (skipReason) {
      console.warn(`\n⚠ SKIPPED: ${skipReason}`);
      return;
    }

    for (const case_ of CASES) {
      const started = Date.now();
      await runOneCase(case_);
      // keep terminal output readable while the suite runs
      const r = results[case_.id] as Record<string, unknown>;
      console.log(
        `[${((Date.now() - started) / 1000).toFixed(0)}s] ${(case_.id as string).padEnd(22)} ` +
        `${String(r.graded?.correct ?? '?').padEnd(5)} verifier=${String(r.verifierVerdict).padEnd(7)} ` +
        `${String(r.classification).padEnd(18)} ` +
        `arch=${r.tokens?.archimedes ?? 0} big=${r.tokens?.largeModel ?? 0}`,
      );
    }

    // Token cost per case, straight from the isolated ledger the alternator appended.
    let costRows: Record<string, { smallModel?: { tokensIn: number; tokensOut: number }; verifier?: { tokensIn: number; tokensOut: number }; largeModel?: { tokensIn: number; tokensOut: number }; outcome: string; wallMs: number }> = {};
    if (process.env.AURA_COST_LOG_DIR) {
      const rows = await loadCostLogs(process.env.AURA_COST_LOG_DIR);
      // one row per run, in order — match by index (runs were sequential)
      const runIds = CASES.map((c) => c.id);
      rows.slice(0, runIds.length).forEach((row, i) => {
        costRows[runIds[i]] = row;
      });
    }

    // Summary counts
    const counts: Record<string, number> = {};
    for (const r of Object.values(results) as Array<Record<string, unknown>>) {
      const k = String(r.classification);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const total = CASES.length;
    const primary = counts['missed-escalation'] ?? 0;
    const falseEsc = counts['false-escalation'] ?? 0;
    console.log('\n=== Full-path escalation-correctness results ===');
    console.log(`missed-escalation: ${primary} (${((primary / total) * 100).toFixed(1)}%)  ← fabrication rate`);
    console.log(`false-escalation:  ${falseEsc} (${((falseEsc / total) * 100).toFixed(1)}%)`);
    console.log(`correct-routing:   ${counts['correct-routing'] ?? 0}`);
    console.log(`small-no-answer:   ${counts['small-no-answer'] ?? 0}`);
    const totalTokens = Object.values(results as Record<string, unknown>).reduce((s, r) => s + (((r as Record<string, unknown>).tokens as Record<string, number> | undefined)?.archimedes ?? 0) + (((r as Record<string, unknown>).tokens as Record<string, number> | undefined)?.largeModel ?? 0), 0);
    console.log(`total tokens (arch+big): ${totalTokens}`);

    // Persist results alongside the verifier-only results
    const resultsPath = new URL('../../benchmark/escalation/results/latest-fullpath.json', import.meta.url).pathname;
    const resultsDir = new URL('../../benchmark/escalation/results/', import.meta.url).pathname;
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(
      resultsPath,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts,
        missedEscalationRate: primary / total,
        falseEscalationRate: falseEsc / total,
        totalTokens,
        costRows,
        results,
      }, null, 2),
    );
    console.log(`results → ${resultsPath}`);

    expect(total).toBe(30);
  });
});
