import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { VerificationReport, ClaimResult } from '../../src/machina/verify.js';
import { renderMachinaTerminal } from '../../src/machina/render-terminal.js';
import { wrapMachinaHtml } from '../../src/machina/render-html.js';
import { runMachina } from '../../src/machina/index.js';

function claim(over: Partial<ClaimResult> = {}): ClaimResult {
  return {
    id: over.id ?? 'main-loop',
    component: over.component ?? 'delta',
    description: over.description ?? 'The main loop.',
    file: over.file ?? 'src/agent/loop.ts',
    line: over.line ?? 127,
    mustContain: over.mustContain ?? 'while (turns < maxTurns)',
    status: over.status ?? 'verified',
    actualLine: over.actualLine,
  };
}

function report(results: ClaimResult[]): VerificationReport {
  return {
    results,
    verifiedCount: results.filter(r => r.status === 'verified').length,
    drifted: results.filter(r => r.status === 'drifted'),
    missing: results.filter(r => r.status === 'missing'),
  };
}

describe('renderMachinaTerminal', () => {
  it('renders the tuple definition and a success banner when all claims verify', () => {
    const out = renderMachinaTerminal(report([claim()]));
    expect(out).toContain('AAM = (S, P, O, δ, s₀)');
    expect(out).toContain('All 1 structural claims verified');
    expect(out).toContain('src/agent/loop.ts:127');
  });

  it('surfaces drifted/missing claims with their expected vs actual content', () => {
    const out = renderMachinaTerminal(report([
      claim({ status: 'drifted', actualLine: 'for (let t = 0; t < maxTurns; t++) {' }),
      claim({ id: 'oracle-call', file: 'src/agent/loop.ts', line: 999, status: 'missing' }),
    ]));
    expect(out).toContain('drifted');
    expect(out).toContain('for (let t = 0');
    expect(out).toMatch(/0\/2 verified|verified — 1 drifted, 1 missing/);
  });

  it('includes the cost/limits explanation and the --html pointer', () => {
    const out = renderMachinaTerminal(report([claim()]));
    expect(out).toMatch(/Halting Problem/i);
    expect(out).toMatch(/quantum/i);
    expect(out).toContain('--html');
  });
});

describe('wrapMachinaHtml', () => {
  it('renders the SVG diagram, tuple definitions, and a verified-status banner', () => {
    const html = wrapMachinaHtml(report([claim()]));
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('class="machina-graph"');
    expect(html).toContain('AAM = (S, P, O, δ, s₀)');
    expect(html).toContain('All 1 structural claims verified');
    expect(html).toContain('class="claims-table"');
  });

  it('shows a warning status line when claims have drifted', () => {
    const html = wrapMachinaHtml(report([claim({ status: 'drifted' })]));
    expect(html).toContain('status-line warn');
    expect(html).toMatch(/drifted/);
  });

  it('HTML-escapes claim descriptions and file paths', () => {
    const html = wrapMachinaHtml(report([
      claim({ description: '<script>alert(1)</script>', file: 'src/<evil>.ts' }),
    ]));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('runMachina', () => {
  let outputRoot: string;

  beforeEach(() => {
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-machina-run-'));
  });

  afterEach(() => {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  it('returns terminal output and writes no file by default', () => {
    const res = runMachina({ outputRoot });
    expect(res.terminalOutput).toContain('Abstract Agent Machine');
    expect(res.htmlPath).toBeUndefined();
    expect(fs.existsSync(path.join(outputRoot, 'docs', 'machina.html'))).toBe(false);
  });

  it('writes docs/machina.html when writeHtml is true, verified against the real repo', () => {
    const res = runMachina({ outputRoot, writeHtml: true });
    expect(res.htmlPath).toBe(path.join(outputRoot, 'docs', 'machina.html'));
    expect(fs.existsSync(res.htmlPath!)).toBe(true);
    // Since this runs inside the actual aura-code checkout, all claims should verify.
    expect(res.report.drifted).toHaveLength(0);
    expect(res.report.missing).toHaveLength(0);
  });

  it('overwrites machina.html on repeated runs rather than accumulating files', () => {
    runMachina({ outputRoot, writeHtml: true });
    const before = fs.readdirSync(path.join(outputRoot, 'docs'));
    runMachina({ outputRoot, writeHtml: true });
    const after = fs.readdirSync(path.join(outputRoot, 'docs'));
    expect(after).toEqual(before);
  });
});
