import * as fs from 'fs';
import * as path from 'path';
import { AAM_CLAIMS, type VerifiableClaim } from './spec.js';

export interface ClaimResult extends VerifiableClaim {
  /**
   * verified — mustContain found at the recorded line (exact anchor).
   * drifted  — mustContain found elsewhere in the file: the claim still
   *            HOLDS, only its line anchor is stale (see foundLine). This is
   *            a passing state — pure line churn is noise, not signal.
   * missing  — mustContain appears nowhere in the file (or the file is
   *            unreadable): the claim is genuinely false. The only failure.
   */
  status: 'verified' | 'drifted' | 'missing';
  /** The actual line content found at the recorded line, if the file exists. */
  actualLine?: string;
  /** Where mustContain actually lives now (1-indexed) — set when drifted. */
  foundLine?: number;
}

/**
 * Check a single claim against the real file on disk. `repoRoot` is the
 * aura-code repository root (NOT the user's current project — the AAM
 * describes aura-code's own machinery, regardless of what project it's
 * currently being run inside).
 *
 * The recorded line number is a lookup hint, not the pass/fail condition:
 * whether the claim is TRUE depends only on the content existing in the file.
 */
function verifyClaim(repoRoot: string, claim: VerifiableClaim): ClaimResult {
  const filePath = path.join(repoRoot, claim.file);
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, 'utf8').split('\n');
  } catch {
    return { ...claim, status: 'missing' };
  }
  const actual = lines[claim.line - 1] ?? '';
  if (actual.includes(claim.mustContain)) {
    return { ...claim, status: 'verified', actualLine: actual.trim() };
  }
  // Anchor miss — search the whole file before declaring the claim false.
  const foundIdx = lines.findIndex(l => l.includes(claim.mustContain));
  if (foundIdx !== -1) {
    return { ...claim, status: 'drifted', actualLine: actual.trim(), foundLine: foundIdx + 1 };
  }
  return { ...claim, status: 'missing', actualLine: actual.trim() };
}

/**
 * Resolve the aura-code installation's own root directory, the same way
 * telegram-bot.ts locates its repo for systemd unit generation. From a
 * compiled module at dist/machina/verify.js, '../..' lands at the repo root
 * (dist/machina -> dist -> root). This is intentionally independent of
 * process.cwd(), since :machina describes aura-code's own machinery, not
 * whatever project the user happens to be running it inside.
 */
export function resolveAuraRepoRoot(): string {
  return path.resolve(__dirname, '../..');
}


export interface VerificationReport {
  results: ClaimResult[];
  verifiedCount: number;
  /** Claims that hold but whose line anchor is stale — passing, needs re-anchoring (see repair.ts). */
  drifted: ClaimResult[];
  /** Claims whose content is genuinely gone — the only real failures. */
  missing: ClaimResult[];
}

/**
 * Verify every structural claim the spec makes. `repoRoot` should be the
 * aura-code installation's own source root — pass `__dirname`-derived paths
 * from the CLI entry point, not the user's project root.
 */
export function verifyAamClaims(repoRoot: string): VerificationReport {
  const results = AAM_CLAIMS.map(c => verifyClaim(repoRoot, c));
  return {
    results,
    verifiedCount: results.filter(r => r.status === 'verified').length,
    drifted: results.filter(r => r.status === 'drifted'),
    missing: results.filter(r => r.status === 'missing'),
  };
}
