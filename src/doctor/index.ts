/**
 * Aura Doctor — entry point. runDoctor() runs all checks, optionally
 * attempts repairs, and returns a DoctorReport. formatDoctorReport()
 * renders it as a colored terminal string.
 *
 * Usage:
 *   const report = await runDoctor({ projectRoot, fix: true });
 *   console.log(formatDoctorReport(report));
 */
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import type { DoctorReport, DoctorOptions, Finding, Severity } from './types.js';
import { ALL_CHECKS, checkLatestVersion } from './checks.js';
import { attemptRepair, type RepairResult } from './repair.js';

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const { projectRoot, fix = false, offline = false } = opts;
  const pkg = readPkgVersion(projectRoot);

  // Run all sync checks
  let findings: Finding[] = [];
  for (const check of ALL_CHECKS) {
    try {
      findings = findings.concat(check.run(projectRoot, offline));
    } catch (e) {
      findings.push({
        category: check.category, name: `${check.category} check`,
        severity: 'error', message: `Check crashed: ${String(e).slice(0, 150)}`,
        fixable: false,
      });
    }
  }

  // Async latest-version check (skipped offline)
  if (!offline && pkg !== 'unknown') {
    const latest = await checkLatestVersion(pkg);
    if (latest) findings.push(latest);
  }

  // Attempt repairs
  const fixed: string[] = [];
  const fixFailed: string[] = [];
  if (fix) {
    const toFix = findings.filter(f => f.fixable);
    const done = new Set<string>();
    for (const f of toFix) {
      // Deduplicate by repair key — e.g. "dist directory" and "dist freshness"
      // both map to "rebuild dist", so only do it once.
      const result = attemptRepair(projectRoot, f);
      if (!result) continue;
      if (done.has(result.name)) continue;
      done.add(result.name);
      if (result.success) {
        fixed.push(f.name);
        // Flip the finding to ok
        f.severity = 'ok';
        f.message = `${f.message} [FIXED: ${result.message}]`;
      } else {
        fixFailed.push(f.name);
        f.detail = (f.detail ?? '') + `\nRepair failed: ${result.message}`;
      }
    }

    // After repairs, re-run the build check to confirm dist is now fresh
    if (fixed.some(n => n.includes('dist') || n === 'entry point' || n === 'dist directory')) {
      const buildCheck = ALL_CHECKS.find(c => c.category === 'build');
      if (buildCheck) {
        const rechecked = buildCheck.run(projectRoot, offline);
        // Replace build-category findings with the rechecked ones
        findings = findings.filter(f => f.category !== 'build').concat(rechecked);
      }
    }
  }

  const summary: Record<Severity, number> = { ok: 0, warn: 0, error: 0, fixable: 0 };
  for (const f of findings) summary[f.severity]++;

  const report: DoctorReport = {
    timestamp: Date.now(),
    version: pkg,
    projectRoot,
    findings,
    summary,
    fixed,
    fixFailed,
  };

  // Persist to .aura/doctor-report.json (gitignored)
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
    const auraDir = path.join(home, '.aura');
    if (!fs.existsSync(auraDir)) fs.mkdirSync(auraDir, { recursive: true });
    fs.writeFileSync(path.join(auraDir, 'doctor-report.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch { /* best-effort */ }

  return report;
}

function readPkgVersion(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch { return 'unknown'; }
}

// ── Formatting ───────────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<Severity, string> = {
  ok: '✓', warn: '⚠', error: '✗', fixable: '⟳',
};
const SEVERITY_COLOR: Record<Severity, (s: string) => string> = {
  ok: chalk.hex('#5a9e6e'),
  warn: chalk.hex('#d4903a'),
  error: chalk.hex('#b15439'),
  fixable: chalk.hex('#d4903a'),
};
const CATEGORY_LABEL: Record<string, string> = {
  build: 'Build', config: 'Config', source: 'Source', assets: 'Assets',
  skills: 'Skills', deps: 'Dependencies', git: 'Git', env: 'Environment',
  version: 'Version', memory: 'Memory',
};

export function formatDoctorReport(report: DoctorReport): string {
  const w = process.stdout.columns ?? 80;
  const line = chalk.hex('#4e3d30')('─'.repeat(Math.min(w - 4, 60)));

  const parts: string[] = [
    '',
    line,
    chalk.hex('#cc785c').bold('  ◆ Aura Doctor — System Diagnostic'),
    chalk.hex('#8a7768')(`  v${report.version} · ${new Date(report.timestamp).toLocaleString()}`),
    line,
    '',
  ];

  // Group findings by category
  const categories = [...new Set(report.findings.map(f => f.category))];
  for (const cat of categories) {
    const catFindings = report.findings.filter(f => f.category === cat);
    parts.push(chalk.hex('#cc785c').bold(`  ${CATEGORY_LABEL[cat] ?? cat}`));
    for (const f of catFindings) {
      const icon = SEVERITY_COLOR[f.severity](SEVERITY_ICON[f.severity]);
      const msg = chalk.hex('#c8b5a0')(f.message);
      const fixTag = f.fixable && !report.fixed.includes(f.name)
        ? ' ' + chalk.hex('#d4903a')('[fixable]')
        : report.fixed.includes(f.name)
          ? ' ' + chalk.hex('#5a9e6e')('[fixed]')
          : '';
      parts.push(`    ${icon} ${msg}${fixTag}`);
      if (f.detail) {
        for (const dl of f.detail.split('\n')) {
          parts.push(chalk.hex('#4e3d30')(`       ${dl}`));
        }
      }
      if (f.fixDescription && f.fixable && !report.fixed.includes(f.name)) {
        parts.push(chalk.hex('#8a7768')(`       → ${f.fixDescription}`));
      }
    }
    parts.push('');
  }

  // Summary
  const s = report.summary;
  const allOk = s.error === 0 && s.warn === 0 && s.fixable === 0;
  parts.push(line);
  if (allOk) {
    parts.push(chalk.hex('#5a9e6e').bold('  ✓ All checks passed — Aura is healthy.'));
  } else {
    const bits: string[] = [];
    if (s.error > 0) bits.push(chalk.hex('#b15439')(`${s.error} error(s)`));
    if (s.warn > 0) bits.push(chalk.hex('#d4903a')(`${s.warn} warning(s)`));
    if (s.fixable > 0) bits.push(chalk.hex('#d4903a')(`${s.fixable} fixable`));
    if (s.ok > 0) bits.push(chalk.hex('#5a9e6e')(`${s.ok} ok`));
    parts.push(`  ${bits.join(' · ')}`);
  }

  if (report.fixed.length > 0) {
    parts.push(chalk.hex('#5a9e6e')(`  ✓ Repaired: ${report.fixed.join(', ')}`));
  }
  if (report.fixFailed.length > 0) {
    parts.push(chalk.hex('#b15439')(`  ✗ Could not repair: ${report.fixFailed.join(', ')}`));
  }

  const fixableCount = report.findings.filter(f => f.fixable && !report.fixed.includes(f.name)).length;
  if (fixableCount > 0 && !report.fixed.length) {
    parts.push(chalk.hex('#8a7768')(`  Run aura --doctor --fix to attempt ${fixableCount} repair(s).`));
  }

  parts.push(line + '\n');
  return parts.join('\n');
}

export type { DoctorReport, DoctorOptions, Finding, Severity } from './types.js';
