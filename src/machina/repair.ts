/**
 * Explicit anchor repair for AAM_CLAIMS — deliberately NOT part of verify.
 *
 * verify.ts is a read-only check: it reports stale anchors (status
 * 'drifted') but never touches source. This module is the separate, opt-in
 * path that rewrites spec.ts's line numbers to match where each claim's
 * content actually lives now. Run it via `npm run repair-anchors`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { verifyAamClaims, resolveAuraRepoRoot } from './verify.js';

export interface AnchorUpdate {
  id: string;
  from: number;
  to: number;
}

export interface RepairResult {
  /** Anchors rewritten in spec.ts. */
  updated: AnchorUpdate[];
  /** Claims whose content is genuinely missing — not repairable, real drift. */
  failing: string[];
}

/**
 * Pure rewrite: for each update, find the claim object by its id and replace
 * its `line: <from>` with `line: <to>`. An update whose recorded line no
 * longer matches the source is skipped rather than guessed at.
 */
export function rewriteSpecAnchors(source: string, updates: AnchorUpdate[]): string {
  let out = source;
  for (const u of updates) {
    const idIdx = out.indexOf(`id: '${u.id}'`);
    if (idIdx === -1) continue;
    const after = out.slice(idIdx);
    const m = after.match(/line:\s*(\d+)/);
    if (!m || Number(m[1]) !== u.from) continue;
    out = out.slice(0, idIdx) + after.replace(/line:\s*\d+/, `line: ${u.to}`);
  }
  return out;
}

/**
 * Verify all claims, then rewrite the stale anchors in src/machina/spec.ts.
 * Returns what was rewritten and which claims are genuinely failing (those
 * cannot be repaired — the content is gone, the spec itself must change).
 */
export function repairAnchors(repoRoot: string = resolveAuraRepoRoot()): RepairResult {
  const report = verifyAamClaims(repoRoot);
  const updated: AnchorUpdate[] = report.drifted
    .filter(r => typeof r.foundLine === 'number')
    .map(r => ({ id: r.id, from: r.line, to: r.foundLine! }));

  if (updated.length > 0) {
    const specPath = path.join(repoRoot, 'src', 'machina', 'spec.ts');
    const source = fs.readFileSync(specPath, 'utf8');
    fs.writeFileSync(specPath, rewriteSpecAnchors(source, updated));
  }

  return { updated, failing: report.missing.map(r => r.id) };
}

// Direct-run entry (`node dist/machina/repair.js`). Guarded so the module
// also loads under ESM-transformed test runners where `require` is undefined.
if (typeof require !== 'undefined' && require.main === module) {
  const { updated, failing } = repairAnchors();
  for (const u of updated) console.log(`re-anchored '${u.id}': line ${u.from} → ${u.to}`);
  if (updated.length === 0) console.log('All anchors exact — nothing to repair.');
  if (failing.length > 0) {
    console.error(`Not repairable (content genuinely missing): ${failing.join(', ')} — the spec itself needs updating.`);
    process.exitCode = 1;
  }
}
