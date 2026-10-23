/**
 * Accountant Two — deterministic fast path in front of the Accountant One loop.
 *
 * Design (DESIGN-accountant-agent.md): most bookkeeping requests are commands,
 * not conversations. "list unpaid", "mark AV-4471 paid", "ingest ~/invoices",
 * "dunning preview", "quarterly report" each map to exactly one bookkeeping
 * tool call. Routing them through an LLM costs a provider round trip (seconds
 * + tokens) and adds a hallucination surface on figures the tool already
 * parses deterministically. This module pattern-matches the request, executes
 * the tool directly, and returns a synthetic LoopResult — zero LLM calls,
 * zero cost, zero latency beyond the tool itself.
 *
 * Anything that does not match returns null and falls through to the normal
 * scoped agent loop, which keeps full LLM judgement for ambiguous, compound,
 * or side-effectful requests. The matchers are deliberately narrow: a false
 * positive would skip the LLM on a request that needed it. Real dunning sends
 * (email leaves the machine) are NEVER fast-pathed — they keep the LLM loop's
 * permission gate.
 */

import * as os from 'os';
import * as path from 'path';
import { bookkeepingTool, type BookkeepingInput } from '../tools/bookkeeping.js';
import type { LoopResult } from './loop.js';
import type { HistoryMessage } from '../providers/types.js';
import { buildAccountantPrompt, ACCOUNTANT_TOOLS } from './accountant-prompt.js';

/** Same scoped toolset as Accountant One — the fast path changes routing, not reach. */
export const ACCOUNTANT2_TOOLS = ACCOUNTANT_TOOLS;

/** Zero-usage tally: no model was called, so nothing was billed. */
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 };

interface FastMatch {
  input: BookkeepingInput;
  /** Short human label for the summary header. */
  label: string;
}

/** Expand ~ and strip quotes/trailing punctuation from a user-typed path. */
function cleanPath(raw: string): string {
  let p = raw.trim().replace(/^["']|["'. ]+$/g, '');
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  return p;
}

/** Invoice-number-shaped token: must contain a digit so "paid"/"invoice" never match. */
const INV = '([A-Za-z0-9][A-Za-z0-9-]*\\d[A-Za-z0-9-]*)';

function matchFastPath(raw: string): FastMatch | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');

  // ── mark_paid ── (before list: "mark paid" contains "paid")
  const mark =
    text.match(new RegExp(`mark\\s+(?:the\\s+)?(?:invoice\\s+)?${INV}\\s+(?:as\\s+)?paid`)) ??
    text.match(new RegExp(`mark\\s+paid\\s+(?:invoice\\s+)?${INV}`)) ??
    text.match(new RegExp(`(?:settle|pay)\\s+(?:the\\s+)?(?:invoice\\s+)?${INV}`));
  if (mark) {
    const invoiceNo = mark[1].toUpperCase();
    const explicitDate = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    return {
      input: { action: 'mark_paid', invoice_no: invoiceNo, paid_date: explicitDate?.[1] },
      label: `mark_paid ${invoiceNo}`,
    };
  }

  // ── ingest ──
  const ingest =
    text.match(/^ingest\s+(.+)$/) ??
    text.match(/(?:parse|process|read)\s+(?:the\s+)?(?:invoices?|pdfs?)\s+(?:from|in|under)\s+(.+)$/);
  if (ingest) {
    const p = cleanPath(ingest[1]);
    if (p) return { input: { action: 'ingest', path: p }, label: `ingest ${p}` };
  }

  // ── dunning ── preview only. A real send (email leaves the machine) must
  // keep the LLM loop's permission gate, so any send intent falls through.
  if (/\bdunning\b/.test(text)) {
    if (/\bsend\b/.test(text)) return null;
    return { input: { action: 'dunning', dry_run: true }, label: 'dunning preview (dry run)' };
  }

  // ── quarterly ──
  if (/\bquarterly\b/.test(text)) {
    return { input: { action: 'quarterly' }, label: 'quarterly report (newest quarter)' };
  }
  const q = text.match(/\bq([1-4])\b/);
  if (q && /\breport|summary|breakdown|numbers\b/.test(text)) {
    const year = text.match(/\b(20\d{2})\b/)?.[1] ?? String(new Date().getFullYear());
    const quarter = `${year}-Q${q[1]}`;
    return { input: { action: 'quarterly', quarter }, label: `quarterly report ${quarter}` };
  }

  // ── list ── (broadest, so last). Guard against prose that merely mentions
  // invoices: require a command-ish opener or a very short message.
  const commandish = /^(list|show|what|which|how much|how many|any|are there|do we|status|summar|report|ledger|invoices?)\b/.test(text);
  // A very short message is only a command if it is about money at all —
  // "hello" and "" are 1 word too, and they belong to the LLM.
  const aboutMoney = /\b(invoice|invoices|ledger|overdue|unpaid|paid|due|owed?|owing|outstanding|supplier|revenue|spend|balance)\b/.test(text);
  const short = text.split(' ').length <= 4 && aboutMoney;
  if (commandish || short) {
    const status = /\boverdue\b/.test(text) ? 'overdue'
      : /\bunpaid|\bdue\b|\bowed?\b|\bowing\b|\boutstanding\b/.test(text) ? 'unpaid'
      : /\bpaid\b/.test(text) ? 'paid'
      : 'all';
    return { input: { action: 'list', status }, label: `ledger (${status})` };
  }

  return null;
}

/**
 * Try to serve `task` with zero LLM calls. Returns a synthetic LoopResult on a
 * match, or null to fall through to the scoped agent loop.
 */
export async function tryAccountantFastPath(
  task: string,
  history: HistoryMessage[],
): Promise<LoopResult | null> {
  const match = matchFastPath(task);
  if (!match) return null;

  const output = await bookkeepingTool(match.input);
  const summary = `⚡ Fast path — no LLM call (${match.label})\n\n${output}`;

  return {
    success: !/^Error:/i.test(output) && !/^Bookkeeping error:/i.test(output),
    summary,
    turns: 0,
    toolCallCount: 1,
    usage: { ...ZERO_USAGE },
    costUsd: 0,
    history: [
      ...history,
      { role: 'user', content: task },
      { role: 'assistant', content: summary },
    ],
    toolCallLog: [{ name: 'bookkeeping', input: match.input as unknown as Record<string, unknown> }],
  };
}

/** Accountant Two prompt: Accountant One's rules, plus fast-path awareness. */
export function buildAccountant2Prompt(): string {
  return [
    buildAccountantPrompt(),
    '',
    '## Accountant Two additions',
    '- Simple one-step bookkeeping commands (list, mark_paid, ingest, dunning preview, quarterly) are served by a deterministic fast path before you are invoked — you will rarely see them.',
    '- When you ARE invoked, the request needed judgement: compound steps, ambiguous figures, or a real dunning send. Take the turns it needs; do not rush.',
    '- Never restate or recompute figures the bookkeeping tool already returned — relay them verbatim.',
    '- Real dunning sends always come through you: confirm the recipient with the user before calling the tool with dry_run=false.',
  ].join('\n');
}
