import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifyAamClaims, resolveAuraRepoRoot } from '../../src/machina/verify.js';
import { AAM_CLAIMS } from '../../src/machina/spec.js';

describe('verifyAamClaims against the real, current source tree', () => {
  it('every claim in AAM_CLAIMS holds against the actual aura-code repo', () => {
    // This is the test that matters most: it catches the exact failure mode
    // the old (never self-checking) AAM-SPEC.md had — claims whose content
    // quietly disappears from the code. Stale line anchors (status 'drifted')
    // do NOT fail here: pure line churn is noise, and re-anchoring is a
    // deliberate `npm run repair-anchors`, not a test failure.
    const repoRoot = resolveAuraRepoRoot();
    const report = verifyAamClaims(repoRoot);

    if (report.missing.length > 0) {
      const details = report.missing
        .map(r => `  [missing] ${r.id} — ${r.file}:${r.line} expected "${r.mustContain}", found "${r.actualLine ?? '(file missing)'}"`)
        .join('\n');
      throw new Error(`AAM claims are genuinely false against source:\n${details}`);
    }

    expect(report.verifiedCount + report.drifted.length).toBe(AAM_CLAIMS.length);
  });
});

describe('verifyAamClaims against a controlled fixture tree', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-machina-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeFixtureFile(relPath: string, lines: string[]): void {
    const full = path.join(repoRoot, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, lines.join('\n'));
  }

  it('marks a claim "missing" when the referenced file does not exist', () => {
    // Don't create any of the files AAM_CLAIMS points at.
    const report = verifyAamClaims(repoRoot);
    expect(report.verifiedCount).toBe(0);
    expect(report.missing).toHaveLength(AAM_CLAIMS.length);
    expect(report.drifted).toHaveLength(0);
  });

  it('marks a claim "verified" when the exact line matches', () => {
    const mainLoopClaim = AAM_CLAIMS.find(c => c.id === 'main-loop')!;
    const sameFileClaims = AAM_CLAIMS.filter(c => c.file === mainLoopClaim.file);
    const totalLines = Math.max(...sameFileClaims.map(c => c.line));
    const lines = Array.from({ length: totalLines }, (_, i) => `// filler line ${i + 1}`);
    for (const c of sameFileClaims) lines[c.line - 1] = c.mustContain;
    writeFixtureFile(mainLoopClaim.file, lines);

    const report = verifyAamClaims(repoRoot);
    const result = report.results.find(r => r.id === 'main-loop')!;
    expect(result.status).toBe('verified');
  });

  it('marks a claim "drifted" (still passing) when an unrelated line above shifts it', () => {
    // The exact false-positive that bit three times in one week: an edit
    // ABOVE the claimed line shifts every anchor below it. The content is
    // still true — it just moved. That must report drifted + foundLine, not
    // a failure.
    const mainLoopClaim = AAM_CLAIMS.find(c => c.id === 'main-loop')!;
    const sameFileClaims = AAM_CLAIMS.filter(c => c.file === mainLoopClaim.file);
    const totalLines = Math.max(...sameFileClaims.map(c => c.line));
    const lines = Array.from({ length: totalLines }, (_, i) => `// filler line ${i + 1}`);
    for (const c of sameFileClaims) lines[c.line - 1] = c.mustContain;
    lines.unshift('// an unrelated new import, say');   // the one-line shift
    writeFixtureFile(mainLoopClaim.file, lines);

    const report = verifyAamClaims(repoRoot);
    for (const c of sameFileClaims) {
      const r = report.results.find(x => x.id === c.id)!;
      expect(r.status).toBe('drifted');
      expect(r.foundLine).toBe(c.line + 1);
    }
    // Drifted is a passing state: nothing is missing, nothing failed.
    expect(report.missing.filter(r => r.file === mainLoopClaim.file)).toHaveLength(0);
  });

  it('marks a claim "missing" when the content is nowhere in the file (genuine drift)', () => {
    const mainLoopClaim = AAM_CLAIMS.find(c => c.id === 'main-loop')!;
    const sameFileClaims = AAM_CLAIMS.filter(c => c.file === mainLoopClaim.file);
    const totalLines = Math.max(...sameFileClaims.map(c => c.line));
    const lines = Array.from({ length: totalLines }, (_, i) => `// filler line ${i + 1}`);
    for (const c of sameFileClaims) {
      lines[c.line - 1] = c.id === mainLoopClaim.id
        ? '  for (let t = 0; t < maxTurns; t++) {' // content genuinely replaced
        : c.mustContain; // every other co-located claim: correct, stays verified
    }
    writeFixtureFile(mainLoopClaim.file, lines);

    const report = verifyAamClaims(repoRoot);
    const mainResult = report.results.find(r => r.id === mainLoopClaim.id)!;
    expect(mainResult.status).toBe('missing');
    expect(mainResult.actualLine).toContain('for (let t = 0');

    for (const c of sameFileClaims) {
      if (c.id === mainLoopClaim.id) continue;
      expect(report.results.find(r => r.id === c.id)?.status).toBe('verified');
    }

    expect(report.drifted).toHaveLength(0);
  });

  it('reports a per-claim mix of verified/drifted/missing independently', () => {
    const mainLoopClaim = AAM_CLAIMS.find(c => c.id === 'main-loop')!;
    const oracleClaim = AAM_CLAIMS.find(c => c.id === 'oracle-call')!;
    // All claims sharing loop.ts get filled correctly except oracle-call:
    // its content is placed at the WRONG line -> drifted (still passing).
    // Every claim in a DIFFERENT file is left missing (never created).
    const sameFileClaims = AAM_CLAIMS.filter(c => c.file === mainLoopClaim.file);
    const totalLines = Math.max(...sameFileClaims.map(c => c.line)) + 1;
    const lines = Array.from({ length: totalLines }, (_, i) => `// filler line ${i + 1}`);
    for (const c of sameFileClaims) {
      if (c.id === oracleClaim.id) {
        lines[c.line - 1] = '  const stream = somethingElse();';
        lines[totalLines - 1] = c.mustContain; // moved, not gone
      } else {
        lines[c.line - 1] = c.mustContain;
      }
    }
    writeFixtureFile(mainLoopClaim.file, lines);

    const report = verifyAamClaims(repoRoot);
    expect(report.results.find(r => r.id === 'main-loop')?.status).toBe('verified');
    const oracleResult = report.results.find(r => r.id === 'oracle-call')!;
    expect(oracleResult.status).toBe('drifted');
    expect(oracleResult.foundLine).toBe(totalLines);
    expect(report.drifted.map(r => r.id)).toEqual(['oracle-call']);
    expect(report.verifiedCount).toBe(sameFileClaims.length - 1);
    expect(report.missing.length).toBe(AAM_CLAIMS.length - sameFileClaims.length);
  });
});

describe('resolveAuraRepoRoot', () => {
  it('resolves to a directory containing package.json', () => {
    const root = resolveAuraRepoRoot();
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
  });
});
