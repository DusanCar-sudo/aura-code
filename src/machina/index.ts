import * as fs from 'fs';
import * as path from 'path';
import { verifyAamClaims, resolveAuraRepoRoot, type VerificationReport } from './verify.js';
import { renderMachinaTerminal } from './render-terminal.js';
import { wrapMachinaHtml } from './render-html.js';

export interface MachinaRunResult {
  report: VerificationReport;
  terminalOutput: string;
  htmlPath?: string;
}

/**
 * Run `:machina` — verify the AAM's structural claims against aura-code's
 * own source tree (not the user's current project — see resolveAuraRepoRoot)
 * and render the result. If `writeHtml` is true, also write a standalone
 * `docs/machina.html` to the user's current project root for easy sharing.
 */
export function runMachina(opts: { outputRoot: string; writeHtml?: boolean }): MachinaRunResult {
  const repoRoot = resolveAuraRepoRoot();
  const report = verifyAamClaims(repoRoot);
  const terminalOutput = renderMachinaTerminal(report);

  if (!opts.writeHtml) {
    return { report, terminalOutput };
  }

  const dir = path.join(opts.outputRoot, 'docs');
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, 'machina.html');
  fs.writeFileSync(htmlPath, wrapMachinaHtml(report));

  return { report, terminalOutput, htmlPath };
}
