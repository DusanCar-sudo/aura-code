#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Persistent mail listener.
//
// Watches every configured mailbox over IMAP and spools newly arrived messages
// as JSON files under ~/.aura/mail-listener/inbox/, so anything local can react
// to mail without holding an IMAP connection itself.
//
// Why polling instead of IMAP IDLE:
//   IDLE gives push latency (~instant) but Gmail drops an idle connection every
//   ~29 minutes and expects a re-issue; a daemon that must survive for weeks is
//   far simpler and more honest as a poller. One minute of latency is invisible
//   for mail that a human reads anyway.
//
// Why UID markers instead of "unseen":
//   Three configured accounts (milodule3, leanproiq-office, leanproiq-aura) are
//   aliases of ONE Gmail inbox. Marking messages seen would let the first alias
//   to poll hide mail from the others; tracking the highest UID per mailbox per
//   account means every alias sees every message exactly once, and a restart or
//   crash never re-notifies old mail.
//
// Read-only by construction: mailboxes are opened with EXAMINE (never SELECT),
// so nothing here can mark a message read or move it.
//
//   aura-mail serve     run the listener (default)
//   aura-mail once      one poll pass, print what is new, exit
//   aura-mail status    show spool size and per-mailbox markers
//
// The HTTP API mirrors the WhatsApp bridge so consumers stay uniform:
//   GET  /health    -> { ok, accounts, lastPoll }
//   GET  /messages  -> spooled entries (newest last)
//   POST /poll      -> force an immediate poll pass
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import * as http from 'http';
import { auraPath } from '../util/aura-home.js';

export const MAIL_INBOX_MAX = 500; // cap spool size; oldest entries are dropped

const DEFAULT_INTERVAL_MS = Number(process.env.AURA_MAIL_INTERVAL_MS ?? '') || 60_000;
const DEFAULT_PORT = Number(process.env.AURA_MAIL_PORT ?? '') || 8795;

/** How many new messages one poll will report before skipping ahead silently. */
export const MAX_PER_POLL = Number(process.env.AURA_MAIL_MAX_PER_POLL ?? '') || 50;

/** Bytes of message body kept as a preview snippet per entry. */
const SNIPPET_BYTES = Number(process.env.AURA_MAIL_SNIPPET_BYTES ?? '') || 4096;

export interface MailInboxEntry {
  id: string;
  account: string;      // the alias that received it (e.g. aura@leanproiq.com)
  uid: number;          // IMAP UID within the mailbox
  from: string;
  subject?: string;
  date?: string;
  snippet?: string;     // decoded text preview, truncated to SNIPPET_BYTES
  timestamp: string;    // when the listener spooled it (ISO)
}

interface AccountConfig {
  label: string;
  user: string;
  pass: string;
  host: string;
  port: number;
}

interface ListenerState {
  /** Highest UID already reported, keyed by "<user>|<mailbox>". */
  lastUid: Record<string, number>;
}

/** Read ~/.aura/email.json and flatten it into pollable accounts. */
export function loadAccounts(): AccountConfig[] {
  const cfgPath = auraPath('email.json');
  if (!fs.existsSync(cfgPath)) return [];
  let cfg: any;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch { return []; }

  const out = new Map<string, AccountConfig>();
  const add = (a: any) => {
    const user = a?.user ?? cfg.smtp_user;
    const pass = a?.app_password ?? a?.password ?? cfg.smtp_pass;
    const host = a?.imap_host ?? a?.smtp_host ?? cfg.imap_host ?? cfg.smtp_host ?? 'imap.gmail.com';
    if (!user || !pass) return;
    // Several aliases share one Gmail login — dedupe on the login so we open
    // one connection per real mailbox instead of three to the same inbox.
    if (out.has(user)) return;
    out.set(user, {
      label: a?.label ?? a?.from ?? user,
      user,
      pass,
      host,
      port: Number(a?.imap_port ?? cfg.imap_port ?? 993),
    });
  };

  for (const a of Object.values(cfg.accounts ?? {})) add(a);
  if (out.size === 0 && cfg.smtp_user) add(cfg);
  return [...out.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal IMAP client over raw TLS.
//
// Deliberately hand-rolled: the repo ships no IMAP dependency and adding one
// for a read-only poller is not worth the supply-chain surface. Only the five
// verbs this listener needs are implemented — CAPABILITY, LOGIN, EXAMINE,
// UID SEARCH, UID FETCH — and every command is tagged so replies can be
// matched without a full parser.
// ─────────────────────────────────────────────────────────────────────────────

class ImapClient {
  private sock: tls.TLSSocket;
  private buf = '';
  private tagN = 0;
  private waiters: Array<{ tag: string; resolve: (lines: string[]) => void }> = [];
  private pending: string[] = [];

  private constructor(sock: tls.TLSSocket) { this.sock = sock; }

  static connect(host: string, port: number, timeoutMs = 20_000): Promise<ImapClient> {
    return new Promise((resolve, reject) => {
      const sock = tls.connect({ host, port, servername: host }, () => {
        const client = new ImapClient(sock);
        client.attach();
        resolve(client);
      });
      sock.setTimeout(timeoutMs);
      sock.once('timeout', () => { sock.destroy(); reject(new Error(`IMAP timeout connecting to ${host}:${port}`)); });
      sock.once('error', reject);
    });
  }

  /** Feed socket data into whole lines and hand completed commands to waiters. */
  private attach(): void {
    this.sock.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = this.buf.indexOf('\r\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 2);
        const w = this.waiters[0];
        if (!w) continue;
        if (line.startsWith(`${w.tag} `)) {
          // Tagged completion line ends the command.
          w.resolve([...this.pending, line]);
          this.pending = [];
          this.waiters.shift();
        } else if (/^\* \d+ EXISTS/.test(line)) {
          // Untagged status noise — ignore.
        } else {
          this.pending.push(line);
        }
      }
    });
    this.sock.on('error', () => { /* surfaced by the awaiting command */ });
  }

  private send(tag: string, cmd: string): Promise<string[]> {
    return new Promise((resolve) => {
      this.waiters.push({ tag, resolve });
      this.sock.write(`${tag} ${cmd}\r\n`);
    });
  }

  async login(user: string, pass: string): Promise<void> {
    const r = await this.send(`a${++this.tagN}`, `LOGIN "${user}" "${pass}"`);
    if (!/OK/i.test(r[r.length - 1] ?? '')) throw new Error(`IMAP login failed for ${user}`);
  }

  /** EXAMINE opens read-only — the listener must never mark mail as seen. */
  async examine(mailbox = 'INBOX'): Promise<void> {
    const r = await this.send(`a${++this.tagN}`, `EXAMINE "${mailbox}"`);
    if (!/OK/i.test(r[r.length - 1] ?? '')) throw new Error(`IMAP EXAMINE ${mailbox} failed`);
  }

  /** UIDs greater than `since` in the currently selected mailbox. */
  async searchSince(sinceUid: number): Promise<number[]> {
    const r = await this.send(`a${++this.tagN}`, `UID SEARCH UID ${sinceUid + 1}:*`);
    const line = r.find((l) => /^\* SEARCH/.test(l)) ?? '';
    return line.replace(/^\* SEARCH\s*/, '').trim().split(/\s+/)
      .map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > sinceUid);
  }

  /** Fetch headers + a body preview for one UID. */
  async fetch(uid: number): Promise<string> {
    const r = await this.send(
      `a${++this.tagN}`,
      `UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.${SNIPPET_BYTES}>)`,
    );
    return r.join('\n');
  }

  close(): void { try { this.sock.end(); } catch { /* already gone */ } }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing — enough RFC 5322 to pull From / Subject / Date and a text preview.
// ─────────────────────────────────────────────────────────────────────────────

/** Decode =?utf-8?B?...?= / =?utf-8?Q?...?= words in a header value. */
export function decodeHeader(raw: string): string {
  return raw.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _cs, enc, data) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
      return data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x: string, h: string) =>
        String.fromCharCode(parseInt(h, 16)));
    } catch { return data; }
  }).trim();
}

function headerValue(block: string, name: string): string | undefined {
  // Headers may be folded across lines; unfold before matching.
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded);
  return m ? decodeHeader(m[1]) : undefined;
}

/**
 * Drop IMAP protocol framing from a UID FETCH response so only message content
 * remains - untagged FETCH lines carry literal size markers ({4096}) that would
 * otherwise leak into every snippet.
 */
export function stripImapFraming(rawIn: string): string {
  return rawIn
    .split(/\r?\n/)
    .filter((l) => !/^\* \d+ FETCH/.test(l))
    .filter((l) => !/^\)\s*$/.test(l))
    .filter((l) => !/^a\d+ (OK|NO|BAD)\b/i.test(l))
    .join('\n')
    .replace(/BODY\[[^\]]*\]\s*\{\d+\}/gi, '');
}

/** Decode quoted-printable soft breaks and =XX escapes. */
export function decodeQuotedPrintable(s: string): string {
  const joined = s.replace(/=\r?\n/g, ''); // soft line break
  // =XX encodes a raw BYTE, not a character: collect the bytes and let UTF-8
  // reassemble multi-byte sequences (otherwise "caf=C3=A9" becomes "cafÃ©").
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const cp = joined.codePointAt(i)!;
      for (const b of Buffer.from(String.fromCodePoint(cp), 'utf8')) bytes.push(b);
      if (cp > 0xffff) i++; // surrogate pair consumed two code units
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Pick the most readable part of a MIME body: prefer a text/plain section,
 * otherwise fall back to whatever came through. Multipart boundary lines and
 * per-part headers are dropped so the preview reads as prose.
 */
export function extractReadableBody(rawIn: string): string {
  // Normalise line endings first: stripImapFraming joins with \n, so a
  // \r\n\r\n-only separator test would miss every real message.
  const raw = rawIn.replace(/\r\n/g, '\n');
  const sep = raw.indexOf('\n\n');
  let body = sep !== -1 ? raw.slice(sep + 2) : raw;

  // Split on MIME boundaries (lines starting with --something).
  const parts = body.split(/^--[^\n]+$/m).filter((p) => p.trim().length > 0);
  if (parts.length > 1) {
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p));
    body = plain ?? parts.find((p) => !/content-type:\s*(image|application)\//i.test(p)) ?? parts[0];
  }

  // Drop any remaining per-part headers at the top of the chunk.
  body = body.replace(/^(?:[A-Za-z-]+:[^\n]*\n)+/, '');
  return decodeQuotedPrintable(body);
}

/** Strip HTML tags and collapse whitespace so a snippet reads as plain text. */
export function toSnippet(raw: string): string {
  let body = extractReadableBody(raw);
  body = body.replace(/<[^>]+>/g, ' ')
             .replace(/&nbsp;/gi, ' ')
             .replace(/&amp;/gi, '&')
             .replace(/&lt;/gi, '<')
             .replace(/&gt;/gi, '>')
             .replace(/\s+/g, ' ')
             .trim();
  return body.slice(0, SNIPPET_BYTES);
}

/** Turn one UID FETCH response into an inbox entry. */
export function parseFetch(account: AccountConfig, uid: number, raw: string): MailInboxEntry {
  const from = headerValue(raw, 'From') ?? '(unknown sender)';
  const subject = headerValue(raw, 'Subject');
  const date = headerValue(raw, 'Date');
  return {
    id: `${account.user}-${uid}`,
    account: account.label,
    uid,
    from,
    subject,
    date,
    snippet: toSnippet(stripImapFraming(raw)),
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spool + state — same shape as the WhatsApp bridge inbox so consumers stay
// uniform, plus a UID marker per mailbox so a restart never re-reports old mail.
// ─────────────────────────────────────────────────────────────────────────────

export function inboxDir(): string { return auraPath('mail-listener', 'inbox'); }
function statePath(): string { return auraPath('mail-listener', 'state.json'); }

export function spoolEntry(entry: MailInboxEntry): void {
  const dir = inboxDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${entry.id}.json`), JSON.stringify(entry, null, 2));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  while (files.length > MAIL_INBOX_MAX) {
    const oldest = files.shift();
    if (!oldest) break;
    try { fs.unlinkSync(path.join(dir, oldest)); } catch { /* raced */ }
  }
}

export function readSpool(): MailInboxEntry[] {
  const dir = inboxDir();
  if (!fs.existsSync(dir)) return [];
  const out: MailInboxEntry[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as MailInboxEntry); }
    catch { /* skip unreadable entry */ }
  }
  return out;
}

export function loadState(): ListenerState {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as ListenerState; }
  catch { return { lastUid: {} }; }
}

export function saveState(state: ListenerState): void {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Poll pass
// ─────────────────────────────────────────────────────────────────────────────

export interface PollResult {
  account: string;
  newCount: number;
  error?: string;
}

/**
 * One pass over every account. On first sight of a mailbox the current highest
 * UID is recorded as the baseline and nothing is reported — otherwise starting
 * the listener would dump an entire inbox into the spool as "new".
 */
export async function pollOnce(state: ListenerState, accounts = loadAccounts()): Promise<PollResult[]> {
  const results: PollResult[] = [];
  for (const acct of accounts) {
    const key = `${acct.user}|INBOX`;
    let client: ImapClient | undefined;
    try {
      client = await ImapClient.connect(acct.host, acct.port);
      await client.login(acct.user, acct.pass);
      await client.examine('INBOX'); // EXAMINE = read-only; never marks mail as seen

      const known = state.lastUid[key];
      if (known === undefined) {
        // First run for this mailbox: baseline only, report nothing.
        const all = await client.searchSince(0);
        state.lastUid[key] = all.length ? Math.max(...all) : 0;
        results.push({ account: acct.label, newCount: 0 });
        continue;
      }

      const uids = await client.searchSince(known);
      let reported = 0;
      for (const uid of uids) {
        if (reported >= MAX_PER_POLL) break; // flood guard; marker still advances
        const raw = await client.fetch(uid);
        spoolEntry(parseFetch(acct, uid, raw));
        reported++;
      }
      if (uids.length) state.lastUid[key] = Math.max(...uids);
      results.push({ account: acct.label, newCount: reported });
    } catch (e: any) {
      results.push({ account: acct.label, newCount: 0, error: e?.message ?? String(e) });
    } finally {
      client?.close();
    }
  }
  saveState(state);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP surface — mirrors the WhatsApp bridge so consumers stay uniform:
//   GET  /health    -> { ok, accounts, lastPoll }
//   GET  /messages  -> spooled entries (newest last)
//   POST /poll      -> force an immediate poll pass
// ─────────────────────────────────────────────────────────────────────────────

export function startServer(port = DEFAULT_PORT): http.Server {
  const state = loadState();
  let lastPoll: string | null = null;
  let accounts: AccountConfig[] = [];

  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, accounts: accounts.map((a) => a.label), lastPoll });
    }
    if (req.method === 'GET' && req.url === '/messages') {
      return send(200, readSpool());
    }
    if (req.method === 'POST' && req.url === '/poll') {
      pollOnce(state, accounts).then((r) => { lastPoll = new Date().toISOString(); send(200, r); })
        .catch((e) => send(500, { error: e?.message ?? String(e) }));
      return;
    }
    send(404, { error: 'not found' });
  });

  const tick = async () => {
    try {
      const r = await pollOnce(state, accounts);
      lastPoll = new Date().toISOString();
      for (const x of r) {
        if (x.error) process.stderr.write(`[mail-listener] ${x.account}: ${x.error}\n`);
        else if (x.newCount > 0) process.stderr.write(`[mail-listener] ${x.account}: ${x.newCount} new\n`);
      }
    } catch (e: any) {
      process.stderr.write(`[mail-listener] poll failed: ${e?.message ?? String(e)}\n`);
    }
  };

  server.listen(port, () => {
    accounts = loadAccounts();
    process.stderr.write(
      `[mail-listener] listening on :${port}, watching ${accounts.length} mailbox(es), every ${DEFAULT_INTERVAL_MS}ms\n`,
    );
    void tick(); // baseline immediately so the first interval is not wasted
    setInterval(() => void tick(), DEFAULT_INTERVAL_MS);
  });
  return server;
}

if (require.main === module) {
  startServer();
}
