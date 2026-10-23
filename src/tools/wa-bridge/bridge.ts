#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp bridge — links Aura to a personal WhatsApp account the same way
// WhatsApp Web does (a linked device), and exposes a small local HTTP API so
// the `whatsapp` tool can send without holding the socket itself.
//
//   aura-wa link     pair a device (prints a QR code)
//   aura-wa serve    run the bridge (default)
//   aura-wa send     send a message through a running bridge
//   aura-wa status   report link state
//   aura-wa logout   unlink and delete the session
//
// The bridge listens on 127.0.0.1 only. It will not send to any number that is
// not explicitly passed in a request, and it never reads a recipient from the
// environment.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as cp from 'child_process';
import { auraPath } from '../../util/aura-home.js';
import { spoolInbox, readInbox, type InboxEntry } from './inbox.js';

const SESSION_DIR = auraPath('wa-session');
const BRIDGE_FILE = auraPath('wa-bridge.json');
const PORT = Number(process.env.AURA_WA_PORT ?? 8794);
const HOST = '127.0.0.1';
const INBOX_DIR = auraPath('wa-inbox');

interface BridgeState {
  port: number;
  pid: number;
  started: string;
}

function writeBridgeFile(): void {
  fs.mkdirSync(path.dirname(BRIDGE_FILE), { recursive: true });
  const state: BridgeState = { port: PORT, pid: process.pid, started: new Date().toISOString() };
  fs.writeFileSync(BRIDGE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function clearBridgeFile(): void {
  try { fs.unlinkSync(BRIDGE_FILE); } catch { /* already gone */ }
}

// Baileys is ESM-only and heavy; load it lazily so `status` stays instant.
type Baileys = typeof import('@whiskeysockets/baileys');

interface SendResult {
  ok: boolean;
  error?: string;
  id?: string;
  to?: string;
}

/** Normalise a human phone number to the JID WhatsApp expects. */
function toJid(number: string): string {
  const cleaned = number.replace(/[\s\-()]/g, '');
  if (cleaned.includes('@')) return cleaned;
  const digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (!/^\d{6,15}$/.test(digits)) {
    throw new Error(`Not a usable phone number: ${number}`);
  }
  return `${digits}@s.whatsapp.net`;
}

/**
 * One-shot send against an already-running bridge, for `aura-wa send`.
 * Stays a thin HTTP client so a single long-lived bridge owns the socket.
 */
async function sendOnce(to: string, message: string): Promise<number> {
  const desc = readBridgeFile();
  if (!desc) {
    process.stderr.write('No bridge is running. Start one with: aura-wa serve\n');
    return 1;
  }
  let res: Response;
  try {
    res = await fetch(`http://${HOST}:${desc.port}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, message }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    process.stderr.write(`Cannot reach the bridge on port ${desc.port}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; id?: string; to?: string; self?: boolean };
  if (!res.ok || !data.ok) {
    process.stderr.write(`Send failed: ${data.error ?? `HTTP ${res.status}`}\n`);
    return 1;
  }
  process.stdout.write(`Sent to ${data.to} (id: ${data.id ?? 'unknown'})${data.self ? ' — note: this is your own account' : ''}\n`);
  return 0;
}

function readBridgeFile(): BridgeState | null {
  if (!fs.existsSync(BRIDGE_FILE)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
    return typeof d?.port === 'number' ? (d as BridgeState) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'serve';

  if (cmd === 'send') {
    const to = process.argv[3];
    const message = process.argv.slice(4).join(' ');
    if (!to || !message) {
      process.stderr.write('usage: aura-wa send <number|contact> "<message>"\n');
      process.exit(2);
    }
    process.exit(await sendOnce(to, message));
  }

  if (cmd === 'contacts') {
    const p = auraPath('wa-contacts.json');
    if (!fs.existsSync(p)) {
      process.stdout.write('No contacts yet. Create ~/.aura/wa-contacts.json as { "William": "+852..." }\n');
      return;
    }
    const book = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, string>;
    const rows = Object.entries(book);
    process.stdout.write(rows.length ? rows.map(([n, v]) => `${n}\t${v}`).join('\n') + '\n' : 'Address book is empty.\n');
    return;
  }

  if (cmd === 'logout') {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    clearBridgeFile();
    process.stdout.write('WhatsApp session deleted. Run `serve` to pair again.\n');
    return;
  }

  if (cmd === 'status') {
    const desc = readBridgeFile();
    let live: { ready?: boolean; me?: { jid?: string; lid?: string } } | null = null;
    if (desc) {
      try {
        const r = await fetch(`http://${HOST}:${desc.port}/health`, { signal: AbortSignal.timeout(4000) });
        if (r.ok) live = await r.json() as { ready?: boolean; me?: { jid?: string; lid?: string } };
      } catch { /* stale file */ }
    }
    if (live?.ready) {
      const who = live.me?.jid ? ` as ${String(live.me.jid).split(':')[0].split('@')[0]}` : '';
      process.stdout.write(`Running and linked${who} on port ${desc!.port}.\n`);
      return;
    }
    const linked = fs.existsSync(path.join(SESSION_DIR, 'creds.json'));
    process.stdout.write(
      live
        ? `Bridge is running on port ${desc!.port} but not linked. Run: aura-wa link\n`
        : linked
          ? 'A session exists but no bridge is running. Start one with: aura-wa serve\n'
          : 'Not linked. Run: aura-wa serve (or aura-wa link) to pair a device.\n',
    );
    return;
  }

  const b = (await import('@whiskeysockets/baileys')) as Baileys;
  const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = b;
  const qrcode = (await import('qrcode-terminal')).default;

  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  let sock: ReturnType<typeof makeWASocket> | null = null;
  let ready = false;
  // Our own identities, so callers can tell "sent to myself" from "sent out".
  const selfIds: { jid?: string; lid?: string } = {};
  const log = (m: string) => process.stdout.write(`[wa] ${m}\n`);

  function connect(): void {
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // Spool every incoming text or voice note into the local inbox so a
    // consumer (concierge daemon) can pick it up via GET /messages.
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return; // ignore history/sends of our own
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const from = m.key.remoteJid ?? '';
        if (!from || from.endsWith('@g.us')) continue; // skip groups
        const id = m.key.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const entry: InboxEntry = {
          id,
          from,
          pushName: m.pushName ?? undefined,
          kind: 'text',
          timestamp: new Date(Number(m.messageTimestamp ?? 0) * 1000 || Date.now()).toISOString(),
        };
        const content = m.message;
        const conv = content?.conversation ?? content?.extendedTextMessage?.text;
        const audioMsg =
          (content as { audioMessage?: { url: string; mimetype: string } } | undefined)?.audioMessage;
        if (audioMsg?.url) {
          try {
            const buf = await downloadMediaMessage(m, 'buffer', {});
            const audioPath = path.join(INBOX_DIR, `${id}.ogg`);
            fs.writeFileSync(audioPath, buf);
            entry.kind = 'audio';
            entry.audioPath = audioPath;
            entry.mimeType = audioMsg.mimetype;
          } catch (e) {
            log(`audio download failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (typeof conv === 'string') {
          entry.text = conv;
        } else {
          continue; // stickers/images/etc — not our channel
        }
        spoolInbox(INBOX_DIR, entry);
        log(`inbox <- ${entry.kind} from ${from} (${id})`);
      }
    });

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        // Keep the raw string too: a wide ASCII QR wraps in most terminals and
        // becomes unscannable, so callers can render it as an image instead.
        try {
          fs.writeFileSync(auraPath('wa-pairing.txt'), qr, { mode: 0o600 });
        } catch { /* not fatal — the terminal QR still works */ }
        log('Scan this with WhatsApp → Settings → Linked devices → Link a device');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        ready = true;
        const me = sock?.user;
        if (me) {
          selfIds.jid = me.id ?? undefined;
          selfIds.lid = (me as { lid?: string }).lid ?? undefined;
        }
        try { fs.unlinkSync(auraPath('wa-pairing.txt')); } catch { /* never written */ }
        log('linked and ready');
        if (cmd === 'link') {
          log('pairing complete — you can stop this process (Ctrl+C); `serve` will reuse the session.');
        }
      }

      if (connection === 'close') {
        ready = false;
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          log('device was unlinked from the phone — session cleared');
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          clearBridgeFile();
          process.exit(0);
        }
        log(`connection closed (${code ?? 'unknown'}) — reconnecting`);
        setTimeout(connect, 3000);
      }
    });
  }

  connect();

  // ── Local API ─────────────────────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/health') {
      return json(200, { ready, session: SESSION_DIR, me: selfIds });
    }

    if (req.method === 'GET' && req.url === '/contacts') {
      const p = auraPath('wa-contacts.json');
      if (!fs.existsSync(p)) return json(200, { contacts: {} });
      try { return json(200, { contacts: JSON.parse(fs.readFileSync(p, 'utf8')) }); }
      catch (e) { return json(500, { error: `wa-contacts.json unreadable: ${String(e)}` }); }
    }

    if (req.method === 'GET' && req.url === '/messages') {
      return json(200, { messages: readInbox(INBOX_DIR) });
    }

    if (req.method === 'POST' && req.url === '/send-audio') {
      let body2 = '';
      req.on('data', (c) => { body2 += c; if (body2.length > 30_000_000) req.destroy(); });
      req.on('end', async () => {
        let payload: { to?: string; audioBase64?: string; mimeType?: string };
        try { payload = JSON.parse(body2 || '{}'); }
        catch { return json(400, { ok: false, error: 'Body must be JSON' }); }
        if (!ready || !sock) return json(503, { ok: false, error: 'WhatsApp bridge is not linked yet' });
        if (!payload.to || !payload.audioBase64) {
          return json(400, { ok: false, error: 'to and audioBase64 are required' });
        }
        try {
          const jid = toJid(payload.to);
          const sent = await sock.sendMessage(jid, {
            audio: Buffer.from(payload.audioBase64, 'base64'),
            ptt: true,
            mimetype: payload.mimeType ?? 'audio/ogg; codecs=opus',
          });
          log(`sent voice note to ${jid}`);
          return json(200, { ok: true, id: sent?.key?.id ?? undefined, to: jid });
        } catch (e) {
          const msg2 = e instanceof Error ? e.message : String(e);
          log(`voice send failed: ${msg2}`);
          return json(500, { ok: false, error: msg2 });
        }
      });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/send') {
      return json(404, { error: 'Not found. Use POST /send or GET /health.' });
    }

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', async () => {
      let payload: { to?: string; message?: string; media?: string };
      try { payload = JSON.parse(body || '{}'); }
      catch { return json(400, { ok: false, error: 'Body must be JSON' }); }

      if (!ready || !sock) {
        return json(503, { ok: false, error: 'WhatsApp bridge is not linked yet' });
      }
      if (!payload.to || !payload.message) {
        return json(400, { ok: false, error: 'to and message are required' });
      }

      try {
        const jid = toJid(payload.to);
        const sent = await sock.sendMessage(jid, { text: payload.message });
        const out: SendResult = { ok: true, id: sent?.key?.id ?? undefined, to: jid };
        log(`sent to ${jid}`);
        return json(200, out);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`send failed: ${msg}`);
        return json(500, { ok: false, error: msg } satisfies SendResult);
      }
    });
  });

  server.listen(PORT, HOST, () => {
    writeBridgeFile();
    log(`listening on http://${HOST}:${PORT} (session: ${SESSION_DIR})`);
  });

  const shutdown = () => {
    log('shutting down');
    clearBridgeFile();
    try { server.close(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  process.stderr.write(`[wa] fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
