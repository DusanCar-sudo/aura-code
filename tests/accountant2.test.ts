/**
 * Accountant Two — deterministic fast-path router tests.
 *
 * The fast path must serve one-step bookkeeping commands with ZERO LLM calls:
 * every match maps to exactly one bookkeeping tool call, and the returned
 * LoopResult carries zero usage. Anything ambiguous or compound must fall
 * through (null) to the scoped agent loop.
 *
 * Ledger isolation: AURA_HOME is pointed at a temp dir, so the real
 * ~/.aura/bookkeeping ledger is never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { tryAccountantFastPath, buildAccountant2Prompt, ACCOUNTANT2_TOOLS } from '../src/agent/accountant2.js';

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-acc2-'));
  previousHome = process.env.AURA_HOME;
  process.env.AURA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.AURA_HOME;
  else process.env.AURA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('Accountant Two fast path — routing', () => {
  it('routes "list unpaid" with zero tokens', async () => {
    const r = await tryAccountantFastPath('list unpaid', []);
    expect(r).not.toBeNull();
    expect(r!.usage.totalTokens).toBe(0);
    expect(r!.turns).toBe(0);
    expect(r!.toolCallCount).toBe(1);
    expect(r!.toolCallLog[0].name).toBe('bookkeeping');
    expect(r!.toolCallLog[0].input).toMatchObject({ action: 'list', status: 'unpaid' });
    expect(r!.summary).toContain('Fast path');
  });

  it('routes "mark AV-4471 paid" to mark_paid', async () => {
    const r = await tryAccountantFastPath('mark AV-4471 paid', []);
    expect(r).not.toBeNull();
    expect(r!.toolCallLog[0].input).toMatchObject({ action: 'mark_paid', invoice_no: 'AV-4471' });
  });

  it('normalises invoice numbers to upper case', async () => {
    const r = await tryAccountantFastPath('mark av-4471 as paid', []);
    expect(r).not.toBeNull();
    expect(r!.toolCallLog[0].input).toMatchObject({ action: 'mark_paid', invoice_no: 'AV-4471' });
  });

  it('routes "settle TB-2026-101877" to mark_paid', async () => {
    const r = await tryAccountantFastPath('settle TB-2026-101877', []);
    expect(r).not.toBeNull();
    expect(r!.toolCallLog[0].input).toMatchObject({ action: 'mark_paid', invoice_no: 'TB-2026-101877' });
  });

  it('dunning defaults to a dry run — never a real send', async () => {
    const r = await tryAccountantFastPath('dunning preview', []);
    expect(r).not.toBeNull();
    expect(r!.toolCallLog[0].input).toMatchObject({ action: 'dunning', dry_run: true });
  });

  it('routes "quarterly report" to quarterly', async () => {
    const r = await tryAccountantFastPath('quarterly report', []);
    expect(r).not.toBeNull();
    expect(r!.toolCallLog[0].input).toMatchObject({ action: 'quarterly' });
  });

  it('routes ingest with ~ expansion', async () => {
    const r = await tryAccountantFastPath('ingest ~/invoices', []);
    expect(r).not.toBeNull();
    const input = r!.toolCallLog[0].input as { action: string; path: string };
    expect(input.action).toBe('ingest');
    expect(input.path).not.toContain('~');
    expect(path.isAbsolute(input.path)).toBe(true);
  });

  it('marks failures as unsuccessful (missing invoice)', async () => {
    const r = await tryAccountantFastPath('mark NOPE-999 paid', []);
    expect(r).not.toBeNull();
    expect(r!.success).toBe(false);
  });
});

describe('Accountant Two fast path — fall-through', () => {
  it.each([
    ['why is our burn rate higher this quarter than last?'],
    ['compare the two biggest suppliers and summarise their terms'],
    ['draft a polite reminder for the overdue invoices and send it to me'],
    ['hello'],
    [''],
  ])('falls through to the LLM loop: %j', async (task) => {
    expect(await tryAccountantFastPath(task, [])).toBeNull();
  });

  it('never fast-paths a real dunning send', async () => {
    expect(await tryAccountantFastPath('send the dunning digest to owner@example.com', [])).toBeNull();
  });
});

describe('Accountant Two prompt & tools', () => {
  it('inherits Accountant One rules and adds fast-path awareness', () => {
    const p = buildAccountant2Prompt();
    expect(p).toContain('Accountant One');
    expect(p).toContain('fast path');
    expect(p).toContain('dry_run=false');
  });

  it('scopes tools to the same set as Accountant One', () => {
    expect(ACCOUNTANT2_TOOLS).toEqual(['bookkeeping', 'email', 'read_file', 'write_file', 'ask_user']);
  });
});
