import chalk from 'chalk';
import { AAM_PREAMBLE, AAM_LIMITS_NOTE } from './spec.js';
import type { VerificationReport, ClaimResult } from './verify.js';

const C = {
  heading: chalk.hex('#cc785c').bold,
  text: chalk.hex('#ede0cc'),
  muted: chalk.hex('#8a7768'),
  dim: chalk.hex('#4e3d30'),
  good: chalk.hex('#5a9e6e'),
  warn: chalk.hex('#b15439'),
  math: chalk.hex('#9e6ecc'),
};

const COMPONENT_LABEL: Record<ClaimResult['component'], string> = {
  S: 'S (state space)',
  P: 'P (primitives)',
  O: 'O (oracle)',
  delta: 'δ (transition fn)',
  s0: 's₀ (initial state)',
  limit: 'limit / invariant',
};

function statusGlyph(status: ClaimResult['status']): string {
  if (status === 'verified') return C.good('✓');
  if (status === 'drifted') return C.warn('⚠');
  return C.warn('✗');
}

export function renderMachinaTerminal(report: VerificationReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(C.heading('  Machina — the Abstract Agent Machine'));
  lines.push('');
  lines.push(C.text(wrapText(AAM_PREAMBLE, 76, '  ')));
  lines.push('');

  lines.push(C.muted('  The tuple'));
  lines.push(`    ${C.math('AAM = (S, P, O, δ, s₀)')}`);
  lines.push('');
  lines.push(`    ${C.heading('S')}   ${C.text('state space — conversation history + loop counters')}`);
  lines.push(`    ${C.heading('P')}   ${C.text('primitives — the finite, fixed set of tool calls')}`);
  lines.push(`    ${C.heading('O')}   ${C.text('the oracle — swappable: LLM, human, rules, or another AAM')}`);
  lines.push(`    ${C.heading('δ')}   ${C.text('transition — δ(s, O(s)) → s′, gated by the safety check')}`);
  lines.push(`    ${C.heading('s₀')}  ${C.text("initial state — empty history + the user's task")}`);
  lines.push('');

  lines.push(C.muted('  Grounding — claims checked against the live source tree'));
  for (const r of report.results) {
    const label = COMPONENT_LABEL[r.component].padEnd(18);
    lines.push(`    ${statusGlyph(r.status)} ${C.dim(label)} ${C.text(r.file + ':' + r.line)}`);
    lines.push(`        ${C.muted(r.description)}`);
    if (r.status !== 'verified') {
      lines.push(`        ${C.warn(`expected "${r.mustContain}" — found: ${r.actualLine || '(file missing)'}`)}`);
    }
  }
  lines.push('');
  if (report.drifted.length === 0 && report.missing.length === 0) {
    lines.push(C.good(`  All ${report.verifiedCount} structural claims verified against the current source.`));
  } else {
    lines.push(C.warn(
      `  ${report.verifiedCount}/${report.results.length} verified — ` +
      `${report.drifted.length} drifted, ${report.missing.length} missing. ` +
      `The code moved; this spec needs updating.`,
    ));
  }
  lines.push('');

  lines.push(C.muted('  Why "unlimited" has a price'));
  lines.push(C.text(wrapText(AAM_LIMITS_NOTE, 76, '  ')));
  lines.push('');
  lines.push(C.muted('  :machina --html  writes the full writeup + diagram to docs/machina.html'));
  lines.push('');

  return lines.join('\n');
}

function wrapText(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      out.push(indent + line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) out.push(indent + line.trim());
  return out.join('\n');
}
