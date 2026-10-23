/**
 * Bookkeeping — invoices in, ledger, payment reminders, quarterly reports.
 *
 * The pipeline a small business actually runs:
 *
 *   ingest   invoice PDFs (a folder, or files pulled out of the mailbox) → parse →
 *            append to the ledger, de-duplicated by supplier + invoice number
 *   list     what is in the ledger, filterable by status
 *   mark_paid  settle an invoice by hand (bank statement said so)
 *   dunning  every unpaid invoice past its due date → one digest email, sent for
 *            real through the email tool (dry_run defaults to true)
 *   quarterly  the quarter's totals, spend by supplier, and the aging of what is
 *            still unpaid → written as a markdown report
 *
 * Two rules this tool never breaks:
 *
 *   1. **It never invents a number.** A PDF whose invoice number, dates or total
 *      cannot be read is reported as skipped, with the reason, and is not put in
 *      the ledger. Guessing at bookkeeping figures is worse than reporting a gap.
 *   2. **Reminders go to the owner, not to the supplier.** dunning composes the
 *      digest addressed to an address the caller names explicitly; nothing is
 *      ever sent to a supplier from here, and a real send requires dry_run=false
 *      *and* a recipient.
 *
 * The ledger is plain JSON under ~/.aura/bookkeeping/ — readable, grep-able,
 * backup-able, and editable by the owner without this tool.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition } from '../providers/types.js';
import { auraPath } from '../util/aura-home.js';
import { extractPdfText } from './pdf-text.js';
import { emailTool } from './email.js';

export interface BookkeepingInput {
  action: 'ingest' | 'list' | 'mark_paid' | 'dunning' | 'quarterly';
  path?: string;        // ingest: a PDF file or a folder of PDFs
  invoice_no?: string;  // mark_paid
  paid_date?: string;   // mark_paid (defaults to today)
  status?: string;      // list: all | unpaid | paid | overdue (default all)
  dry_run?: boolean;    // dunning: true (default) previews, false sends
  to?: string;          // dunning: the owner's address for the digest
  quarter?: string;     // quarterly: "2026-Q3" (default: newest quarter with data)
}

export const BOOKKEEPING_DEFINITION: ToolDefinition = {
  name: 'bookkeeping',
  description:
    'Bookkeeping pipeline: parse invoice PDFs into a ledger, list and settle invoices, ' +
    'chase overdue payments with a real reminder email, and produce quarterly reports. ' +
    'Actions: ingest (path = PDF file or folder), list (status filter), mark_paid ' +
    '(invoice_no), dunning (dry_run default true; to = recipient for a real send), ' +
    'quarterly (quarter = "2026-Q3"). Supplier phone calls are roadmap, not implemented.',
  parameters: {
    type: 'object',
    properties: {
      action:     { type: 'string', description: 'Action: ingest, list, mark_paid, dunning, quarterly' },
      path:       { type: 'string', description: 'For ingest: a PDF file or a folder containing PDFs' },
      invoice_no: { type: 'string', description: 'For mark_paid: the invoice number to settle' },
      paid_date:  { type: 'string', description: 'For mark_paid: ISO date (default: today)' },
      status:     { type: 'string', description: 'For list: all | unpaid | paid | overdue (default all)' },
      dry_run:    { type: 'boolean', description: 'For dunning: true previews (default), false sends the email' },
      to:         { type: 'string', description: 'For dunning: recipient of the reminder digest (owner, never the supplier)' },
      quarter:    { type: 'string', description: 'For quarterly: e.g. 2026-Q3 (default: newest quarter in the ledger)' },
    },
    required: ['action'],
  },
};

interface LedgerEntry {
  supplier: string;
  invoice_no: string;
  issue_date: string;
  due_date: string;
  currency: string;
  net: number;
  vat: number;
  total: number;
  item?: string;
  status: 'unpaid' | 'paid';
  paid_date?: string;
  source_file: string;
  ingested_at: string;
}

interface Ledger {
  version: number;
  entries: LedgerEntry[];
}

// ── storage ──────────────────────────────────────────────────────────────────

function bookkeepingDir(): string {
  const dir = auraPath('bookkeeping');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ledgerPath(): string {
  return path.join(bookkeepingDir(), 'ledger.json');
}

function loadLedger(): Ledger {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    return { version: 1, entries: parsed.entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

function saveLedger(ledger: Ledger): void {
  fs.writeFileSync(ledgerPath(), JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
}

// ── parsing ──────────────────────────────────────────────────────────────────

/** "10.754,42" (EU) or "10,754.42" (US) or "640" → 10754.42 / 640 */
export function parseAmount(raw: string): number | null {
  const s = raw.trim().replace(/[€$\s]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // whichever separator comes last is the decimal point
    normalized = lastComma > lastDot
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // "640,00" decimal comma; "1,234" (3 digits) is a thousands separator
    normalized = s.length - lastComma - 1 === 3 ? s.replace(',', '') : s.replace(',', '.');
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** ISO "2026-07-03" or EU "03.07.2026" → ISO; anything else → null */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    return `${m[3]}-${mm}-${dd}`;
  }
  return null;
}

function field(text: string, label: RegExp): string | null {
  const m = text.match(label);
  return m ? m[1].trim() : null;
}

export interface ParsedInvoice {
  ok: boolean;
  reason?: string;
  record?: Omit<LedgerEntry, 'status' | 'ingested_at'>;
}

/** Label-driven parser. Anything it cannot read is a reported skip, never a guess. */
export function parseInvoiceText(text: string, sourceFile: string): ParsedInvoice {
  const supplier = field(text, /Supplier\s*:\s*(.+)/i);
  const invoiceNo = field(text, /Invoice\s*(?:No|Number|#)\s*[:.]?\s*([A-Za-z0-9][A-Za-z0-9\-_\/]{2,})/i);
  const issueRaw = field(text, /Issue\s*Date\s*:\s*(.+)/i);
  const dueRaw = field(text, /Due\s*Date\s*:\s*(.+)/i);
  const netRaw = field(text, /Net\s*:\s*(.+)/i);
  const vatRaw = field(text, /VAT[^:]*:\s*(.+)/i);
  const totalRaw = field(text, /Total\s*:\s*(.+)/i);
  const currencyRaw = field(text, /Currency\s*:\s*([A-Za-z]{3})/i);

  const missing: string[] = [];
  if (!supplier) missing.push('supplier');
  if (!invoiceNo) missing.push('invoice number');
  if (!issueRaw) missing.push('issue date');
  if (!dueRaw) missing.push('due date');
  if (!totalRaw) missing.push('total');
  if (missing.length) return { ok: false, reason: `unreadable: ${missing.join(', ')}` };

  const issue = parseDate(issueRaw!);
  const due = parseDate(dueRaw!);
  if (!issue || !due) return { ok: false, reason: 'unreadable: date format' };

  const total = parseAmount(totalRaw!);
  if (total === null) return { ok: false, reason: 'unreadable: total amount' };

  const net = netRaw ? parseAmount(netRaw) : null;
  const vat = vatRaw ? parseAmount(vatRaw) : null;
  const item = field(text, /Item\s*:\s*(.+)/i)?.replace(/\s+/g, ' ') ?? undefined;

  return {
    ok: true,
    record: {
      supplier: supplier!,
      invoice_no: invoiceNo!,
      issue_date: issue,
      due_date: due,
      currency: (currencyRaw ?? 'EUR').toUpperCase(),
      net: net ?? (vat !== null ? Number((total - vat).toFixed(2)) : total),
      vat: vat ?? Number((total - (net ?? total)).toFixed(2)),
      total,
      item,
      source_file: sourceFile,
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000);
}

function money(v: number, currency = 'EUR'): string {
  const symbol = currency === 'EUR' ? '€' : currency + ' ';
  return symbol + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isOverdue(e: LedgerEntry, at: string): boolean {
  return e.status === 'unpaid' && e.due_date < at;
}

function quarterOf(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

// ── actions ──────────────────────────────────────────────────────────────────

async function ingest(target: string): Promise<string> {
  const stat = fs.existsSync(target) ? fs.statSync(target) : null;
  if (!stat) return `Error: no such file or folder: ${target}`;
  const files: string[] = [];
  if (stat.isDirectory()) {
    for (const f of fs.readdirSync(target).sort()) {
      if (f.toLowerCase().endsWith('.pdf')) files.push(path.join(target, f));
    }
  } else {
    files.push(target);
  }
  if (!files.length) return `No PDFs in ${target}`;

  const ledger = loadLedger();
  const seen = new Set(ledger.entries.map(e => `${e.supplier}::${e.invoice_no}`));
  const added: LedgerEntry[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    let text = '';
    try {
      const extracted = await extractPdfText(file, true);
      text = extracted.text ?? '';
    } catch (e) {
      skipped.push(`${path.basename(file)} — unreadable PDF (${String(e)})`);
      continue;
    }
    const parsed = parseInvoiceText(text, file);
    if (!parsed.ok || !parsed.record) {
      skipped.push(`${path.basename(file)} — ${parsed.reason}`);
      continue;
    }
    const key = `${parsed.record.supplier}::${parsed.record.invoice_no}`;
    if (seen.has(key)) {
      skipped.push(`${path.basename(file)} — already in the ledger (${parsed.record.invoice_no})`);
      continue;
    }
    seen.add(key);
    const entry: LedgerEntry = { ...parsed.record, status: 'unpaid', ingested_at: new Date().toISOString() };
    ledger.entries.push(entry);
    added.push(entry);
  }

  if (added.length) saveLedger(ledger);

  const lines = [`Ingested ${added.length} of ${files.length} invoice(s) → ${ledgerPath()}`, ''];
  for (const e of added) {
    lines.push(`  + ${e.invoice_no.padEnd(18)} ${e.supplier.padEnd(24)} ${money(e.total, e.currency).padStart(12)}  due ${e.due_date}`);
  }
  if (skipped.length) {
    lines.push('', `Skipped ${skipped.length}:`);
    for (const s of skipped) lines.push(`  - ${s}`);
  }
  const unpaid = ledger.entries.filter(e => e.status === 'unpaid');
  lines.push('', `Ledger: ${ledger.entries.length} entries, ${unpaid.length} unpaid, ` +
    `${money(unpaid.reduce((s, e) => s + e.total, 0))} outstanding.`);
  return lines.join('\n');
}

function list(status: string, at = today()): string {
  const ledger = loadLedger();
  if (!ledger.entries.length) return 'Ledger is empty — run ingest first.';
  const entries = ledger.entries
    .filter(e => {
      if (status === 'unpaid') return e.status === 'unpaid';
      if (status === 'paid') return e.status === 'paid';
      if (status === 'overdue') return isOverdue(e, at);
      return true;
    })
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  if (!entries.length) return `No ${status} entries.`;
  const lines = [`${entries.length} ${status} entr${entries.length === 1 ? 'y' : 'ies'} (as of ${at}):`, ''];
  for (const e of entries) {
    const tail = e.status === 'paid'
      ? `paid ${e.paid_date}`
      : isOverdue(e, at) ? `OVERDUE ${daysBetween(e.due_date, at)}d` : `due ${e.due_date}`;
    lines.push(`  ${e.invoice_no.padEnd(18)} ${e.supplier.padEnd(24)} ${money(e.total, e.currency).padStart(12)}  ${tail}`);
  }
  const sum = entries.reduce((s, e) => s + e.total, 0);
  lines.push('', `Total: ${money(sum)}`);
  return lines.join('\n');
}

function markPaid(invoiceNo: string, paidDate?: string): string {
  const ledger = loadLedger();
  const entry = ledger.entries.find(e => e.invoice_no.toLowerCase() === invoiceNo.toLowerCase());
  if (!entry) return `Error: no invoice ${invoiceNo} in the ledger`;
  if (entry.status === 'paid') return `${entry.invoice_no} was already paid on ${entry.paid_date}.`;
  entry.status = 'paid';
  entry.paid_date = paidDate ?? today();
  saveLedger(ledger);
  return `Marked ${entry.invoice_no} (${entry.supplier}, ${money(entry.total, entry.currency)}) paid on ${entry.paid_date}.`;
}

async function dunning(dryRun: boolean, to?: string, at = today()): Promise<string> {
  const ledger = loadLedger();
  const overdue = ledger.entries.filter(e => isOverdue(e, at))
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  if (!overdue.length) return `Nothing overdue as of ${at} — no reminders to send.`;

  const total = overdue.reduce((s, e) => s + e.total, 0);
  const subject = `Overdue supplier invoices — ${overdue.length} payment${overdue.length === 1 ? '' : 's'}, ${money(total)}`;
  const body = [
    `As of ${at} the following supplier invoices are past their due date:`,
    '',
    ...overdue.map(e =>
      `  • ${e.invoice_no}  ${e.supplier}  ${money(e.total, e.currency)}  ` +
      `due ${e.due_date} (${daysBetween(e.due_date, at)} days overdue)`),
    '',
    `Total outstanding: ${money(total)}`,
    '',
    'Raise a payment order for the ones you want settled and mark them paid in the ledger;',
    'this reminder is rebuilt from the ledger on every run, so it is always current.',
  ].join('\n');

  if (dryRun) {
    return [`Dunning preview (dry run — nothing sent):`, '', `To: ${to ?? '(none given; a real send requires to=)'}`,
      `Subject: ${subject}`, '', body].join('\n');
  }
  if (!to) return 'Error: a real send requires to= (dry_run=false sends the reminder digest)';
  const result = await emailTool({ action: 'send', to, subject, body });
  return `Reminder sent to ${to}\nSubject: ${subject}\n\n${result}`;
}

function quarterly(quarter?: string): string {
  const ledger = loadLedger();
  if (!ledger.entries.length) return 'Ledger is empty — run ingest first.';
  const quarters = [...new Set(ledger.entries.map(e => quarterOf(e.issue_date)))].sort();
  const q = quarter ?? quarters[quarters.length - 1];
  const entries = ledger.entries.filter(e => quarterOf(e.issue_date) === q);
  if (!entries.length) return `No invoices in ${q}. Quarters with data: ${quarters.join(', ')}`;

  const at = today();
  const totalNet = entries.reduce((s, e) => s + e.net, 0);
  const totalVat = entries.reduce((s, e) => s + e.vat, 0);
  const totalGross = entries.reduce((s, e) => s + e.total, 0);
  const bySupplier = new Map<string, number>();
  for (const e of entries) bySupplier.set(e.supplier, (bySupplier.get(e.supplier) ?? 0) + e.total);

  const unpaid = entries.filter(e => e.status === 'unpaid');
  const buckets: Array<[string, (d: number) => boolean]> = [
    ['not yet due', d => d < 0],
    ['1–30 days', d => d >= 1 && d <= 30],
    ['31–60 days', d => d >= 31 && d <= 60],
    ['61–90 days', d => d >= 61 && d <= 90],
    ['90+ days', d => d > 90],
  ];
  const aging = buckets.map(([label, test]) => {
    const rows = unpaid.filter(e => test(daysBetween(e.due_date, at)));
    return { label, count: rows.length, total: rows.reduce((s, e) => s + e.total, 0) };
  });

  const md = [
    `# Quarterly report — ${q}`,
    '',
    `Generated ${at} from ${ledgerPath()} (${entries.length} invoices).`,
    '',
    '## Totals',
    '',
    `| | |`,
    `|---|---:|`,
    `| Net | ${money(totalNet)} |`,
    `| VAT | ${money(totalVat)} |`,
    `| Gross | ${money(totalGross)} |`,
    `| Unpaid | ${money(unpaid.reduce((s, e) => s + e.total, 0))} (${unpaid.length} invoices) |`,
    '',
    '## Spend by supplier',
    '',
    '| Supplier | Gross |',
    '|---|---:|',
    ...[...bySupplier.entries()].sort((a, b) => b[1] - a[1]).map(([s, v]) => `| ${s} | ${money(v)} |`),
    '',
    '## Aging of unpaid invoices (as of report date)',
    '',
    '| Age | Invoices | Amount |',
    '|---|---:|---:|',
    ...aging.map(a => `| ${a.label} | ${a.count} | ${money(a.total)} |`),
    '',
  ].join('\n');

  const reportsDir = path.join(bookkeepingDir(), 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `quarter-${q}.md`);
  fs.writeFileSync(reportPath, md);

  const summary = [
    `${q}: gross ${money(totalGross)} across ${entries.length} invoices, ` +
    `${bySupplier.size} suppliers; ${unpaid.length} still unpaid (${money(unpaid.reduce((s, e) => s + e.total, 0))}).`,
    `Report written to ${reportPath}`,
    '',
    md,
  ].join('\n');
  return summary;
}

export async function bookkeepingTool(input: BookkeepingInput): Promise<string> {
  try {
    switch (input.action) {
      case 'ingest':
        if (!input.path) return 'Error: ingest requires path= (a PDF or a folder of PDFs)';
        return await ingest(input.path);
      case 'list':
        return list(input.status ?? 'all');
      case 'mark_paid':
        if (!input.invoice_no) return 'Error: mark_paid requires invoice_no=';
        return markPaid(input.invoice_no, input.paid_date);
      case 'dunning':
        return await dunning(input.dry_run !== false, input.to);
      case 'quarterly':
        return quarterly(input.quarter);
      default:
        return `Error: unknown bookkeeping action: ${input.action}`;
    }
  } catch (e) {
    return `Bookkeeping error: ${String(e)}`;
  }
}
