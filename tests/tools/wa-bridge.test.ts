import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spoolInbox, readInbox, INBOX_MAX } from '../../src/tools/wa-bridge/inbox.js';

describe('wa-bridge inbox spool', () => {
  let inbox: string;
  beforeEach(() => { inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-inbox-')); });

  const entry = (id: string) => ({
    id, from: '381641234567@s.whatsapp.net', kind: 'text' as const,
    text: `hello ${id}`, timestamp: new Date().toISOString(),
  });

  it('spools an entry readable via readInbox', () => {
    spoolInbox(inbox, entry('A1'));
    const msgs = readInbox(inbox);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('A1');
    expect(msgs[0].kind).toBe('text');
    expect(msgs[0].text).toBe('hello A1');
  });

  it('spools audio entries with audioPath and mimeType', () => {
    spoolInbox(inbox, { ...entry('A2'), kind: 'audio', audioPath: '/tmp/a.ogg', mimeType: 'audio/ogg; codecs=opus' });
    const [m] = readInbox(inbox);
    expect(m.kind).toBe('audio');
    expect(m.audioPath).toBe('/tmp/a.ogg');
  });

  it('returns entries sorted by id (oldest first)', () => {
    for (const id of ['C3', 'A1', 'B2']) spoolInbox(inbox, entry(id));
    expect(readInbox(inbox).map((m) => m.id)).toEqual(['A1', 'B2', 'C3']);
  });

  it('skips unreadable entries instead of throwing', () => {
    spoolInbox(inbox, entry('OK'));
    fs.writeFileSync(path.join(inbox, 'bad.json'), '{not json');
    const msgs = readInbox(inbox);
    expect(msgs.map((m) => m.id)).toEqual(['OK']);
  });

  it(`caps the spool at ${INBOX_MAX} dropping oldest first`, () => {
    for (let i = 0; i < INBOX_MAX + 5; i++) spoolInbox(inbox, entry(`CAP${String(i).padStart(4, '0')}`));
    const files = fs.readdirSync(inbox).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(INBOX_MAX);
    expect(fs.existsSync(path.join(inbox, 'CAP0000.json'))).toBe(false);
    expect(fs.existsSync(path.join(inbox, `CAP${String(INBOX_MAX + 4).padStart(4, '0')}.json`))).toBe(true);
  });
});
