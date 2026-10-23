// ─────────────────────────────────────────────────────────────────────────────
// Incoming-message inbox for the WhatsApp bridge.
//
// Messages (text and voice notes) are spooled as JSON files so local consumers
// (concierge daemon, CLI) can poll GET /messages without the bridge holding
// any conversation state itself. Voice-note media is stored next to its entry
// as <id>.ogg.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';

export const INBOX_MAX = 500; // cap spool size; oldest entries are dropped

export interface InboxEntry {
  id: string;
  from: string;
  pushName?: string;
  kind: 'text' | 'audio';
  text?: string;          // for kind === 'text'
  audioPath?: string;     // for kind === 'audio' (raw media, .ogg)
  mimeType?: string;
  timestamp: string;
}

export function spoolInbox(inboxDir: string, entry: InboxEntry): void {
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, `${entry.id}.json`), JSON.stringify(entry));
  const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json')).sort();
  while (files.length > INBOX_MAX) {
    const oldest = files.shift();
    if (!oldest) break;
    try { fs.unlinkSync(path.join(inboxDir, oldest)); } catch { /* raced */ }
  }
}

export function readInbox(inboxDir: string): InboxEntry[] {
  if (!fs.existsSync(inboxDir)) return [];
  const out: InboxEntry[] = [];
  for (const f of fs.readdirSync(inboxDir).filter((x) => x.endsWith('.json')).sort()) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8')) as InboxEntry); }
    catch { /* skip unreadable entry */ }
  }
  return out;
}
