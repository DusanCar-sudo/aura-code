import * as fs from 'fs';
import * as path from 'path';
import { AAM_CLAIMS, type VerifiableClaim } from './spec.js';

export interface ClaimResult extends VerifiableClaim {
  status: 'verified' | 'drifted' | 'missing';
  /** The actual line content found, if the file exists. */
  actualLine?: string;
}

/**
 * Check a single claim against the real file on disk. `repoRoot` is the
 * aura-code repository root (NOT the user's current project — the AAM
 * describes aura-code's own machinery, regardless of what project it's
 * currently being run inside).
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
  const status = actual.includes(claim.mustContain) ? 'verified' : 'drifted';
  return { ...claim, status, actualLine: actual.trim() };
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
  drifted: ClaimResult[];
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
