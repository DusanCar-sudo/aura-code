import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifyAamClaims, resolveAuraRepoRoot } from '../../src/machina/verify.js';
import { AAM_CLAIMS } from '../../src/machina/spec.js';

describe('verifyAamClaims against the real, current source tree', () => {
  it('every claim in AAM_CLAIMS verifies against the actual aura-code repo', () => {
    // This is the test that matters most: it catches the exact failure mode
    // the old (never self-checking) AAM-SPEC.md had — claims that quietly
    // drift from the code as it changes. Run against the real repo root.
    const repoRoot = resolveAuraRepoRoot();
    const report = verifyAamClaims(repoRoot);

    if (report.drifted.length > 0 || report.missing.length > 0) {
      const details = [...report.drifted, ...report.missing]
        .map(r => `  [${r.status}] ${r.id} — ${r.file}:${r.line} expected "${r.mustContain}", found "${r.actualLine ?? '(missing)'}"`)
        .join('\n');
      throw new Error(`AAM claims have drifted from source:\n${details}`);
    }

    expect(report.verifiedCount).toBe(AAM_CLAIMS.length);
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

  it('marks a claim "drifted" when the line exists but content changed (the code moved)', () => {
    const mainLoopClaim = AAM_CLAIMS.find(c => c.id === 'main-loop')!;
    // Build the fixture from every claim that shares mainLoopClaim.file, so
    // claims at OTHER lines in the same file stay correctly "verified" and
    // don't incidentally register as drifted noise in this test.
    const sameFileClaims = AAM_CLAIMS.filter(c => c.file === mainLoopClaim.file);
    const totalLines = Math.max(...sameFileClaims.map(c => c.line));
    const lines = Array.from({ length: totalLines }, (_, i) => `// filler line ${i + 1}`);
    for (const c of sameFileClaims) {
      lines[c.line - 1] = c.id === mainLoopClaim.id
        ? '  for (let t = 0; t < maxTurns; t++) {' // the one claim under test: drifted
        : c.mustContain; // every other co-located claim: correct, stays verified
    }
    writeFixtureFile(mainLoopClaim.file, lines);

    const report = verifyAamClaims(repoRoot);
    const mainResult = report.results.find(r => r.id === mainLoopClaim.id)!;
    expect(mainResult.status).toBe('drifted');
    expect(mainResult.actualLine).toContain('for (let t = 0');

    for (const c of sameFileClaims) {
      if (c.id === mainLoopClaim.id) continue;
      expect(report.results.find(r => r.id === c.id)?.status).toBe('verified');
    }

    expect(report.drifted).toHaveLength(1);
  });

  it('reports a per-claim mix of verified/drifted/missing independently', () => {
    const mainLoopClaim = AAM_CLAIMS.find(c => c.id === 'main-loop')!;
    const oracleClaim = AAM_CLAIMS.find(c => c.id === 'oracle-call')!;
    // All claims sharing loop.ts get filled correctly except oracle-call,
    // which gets deliberately wrong content -> drifted. Every claim in a
    // DIFFERENT file is left missing (never created).
    const sameFileClaims = AAM_CLAIMS.filter(c => c.file === mainLoopClaim.file);
    const totalLines = Math.max(...sameFileClaims.map(c => c.line));
    const lines = Array.from({ length: totalLines }, (_, i) => `// filler line ${i + 1}`);
    for (const c of sameFileClaims) {
      lines[c.line - 1] = c.id === oracleClaim.id ? '  const stream = somethingElse();' : c.mustContain;
    }
    writeFixtureFile(mainLoopClaim.file, lines);

    const report = verifyAamClaims(repoRoot);
    expect(report.results.find(r => r.id === 'main-loop')?.status).toBe('verified');
    expect(report.results.find(r => r.id === 'oracle-call')?.status).toBe('drifted');
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
