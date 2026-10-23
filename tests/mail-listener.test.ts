/**
 * Persistent mail listener tests.
 *
 * Everything runs against an isolated AURA_HOME in a temp dir, so the tests
 * never touch the real spool at ~/.aura/mail-listener and never open a socket.
 * Only the pure pieces are exercised here — header decoding, snippet cleanup,
 * fetch parsing, account flattening and spool/state round-trips; the IMAP
 * client itself is covered by the live smoke run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-mail-'));
  prevHome = process.env.AURA_HOME;
  process.env.AURA_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AURA_HOME;
  else process.env.AURA_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Imported lazily so auraPath() resolves against the temp AURA_HOME above.
async function mod() {
  return await import('../src/tools/mail-listener.js');
}

describe('decodeHeader', () => {
  it('decodes base64-encoded UTF-8 words', async () => {
    const { decodeHeader } = await mod();
    // "Dušan" as a base64 RFC 2047 word.
    expect(decodeHeader('=?utf-8?B?RHXFoWFu?=')).toBe('Dušan');
  });

  it('decodes quoted-printable words and underscores as spaces', async () => {
    const { decodeHeader } = await mod();
    expect(decodeHeader('=?utf-8?Q?Hello_World?=')).toBe('Hello World');
  });

  it('leaves plain headers untouched', async () => {
    const { decodeHeader } = await mod();
    expect(decodeHeader('William Wong <williamwong.cs@gmail.com>')).toBe(
      'William Wong <williamwong.cs@gmail.com>',
    );
  });
});

describe('toSnippet', () => {
  it('strips HTML tags and collapses whitespace', async () => {
    const { toSnippet } = await mod();
    const raw = 'Subject: x\r\n\r\n<html><body><p>Hello   <b>there</b></p></body></html>';
    expect(toSnippet(raw)).toBe('Hello there');
  });

  it('unescapes common entities', async () => {
    const { toSnippet } = await mod();
    expect(toSnippet('\r\n\r\nA &amp; B &lt;C&gt;')).toBe('A & B <C>');
  });
});

describe('parseFetch', () => {
  it('pulls From, Subject and Date out of a folded header block', async () => {
    const { parseFetch } = await mod();
    const raw = [
      'From: William Wong <williamwong.cs@gmail.com>',
      'Subject: Re: Aura Code — demo',
      '\tand investment discussion',
      'Date: Thu, 15 Oct 2026 07:24:31 +0800',
      '',
      'Hi Aura, later today at 9.00 am Malaysia time.',
    ].join('\r\n');

    const entry = parseFetch(
      { label: 'Aura (alias of milodule3)', user: 'milodule3@gmail.com', pass: 'x', host: 'h', port: 993 },
      42,
      raw,
    );

    expect(entry.uid).toBe(42);
    expect(entry.id).toBe('milodule3@gmail.com-42');
    expect(entry.account).toBe('Aura (alias of milodule3)');
    expect(entry.from).toContain('williamwong.cs@gmail.com');
    // Folded subject must be unfolded into one line.
    expect(entry.subject).toBe('Re: Aura Code — demo and investment discussion');
    expect(entry.snippet).toContain('9.00 am Malaysia time');
  });

  it('falls back to a placeholder when From is missing', async () => {
    const { parseFetch } = await mod();
    const entry = parseFetch(
      { label: 'L', user: 'u@x.com', pass: 'x', host: 'h', port: 993 },
      1,
      '\r\n\r\nbody only',
    );
    expect(entry.from).toBe('(unknown sender)');
  });
});

describe('stripImapFraming', () => {
  it('removes untagged FETCH lines, size markers and the tagged completion', async () => {
    const { stripImapFraming } = await mod();
    const raw = [
      '* 8994 FETCH (UID 9252 BODY[TEXT] {4096}',
      'Hello there, this is the real body.',
      ')',
      'a7 OK UID FETCH completed',
    ].join('\r\n');
    const out = stripImapFraming(raw);
    expect(out).not.toMatch(/FETCH/);
    expect(out).not.toMatch(/\{4096\}/);
    expect(out).not.toMatch(/a7 OK/);
    expect(out).toContain('Hello there, this is the real body.');
  });

  it('leaves a clean body untouched', async () => {
    const { stripImapFraming } = await mod();
    expect(stripImapFraming('Just a plain line.')).toBe('Just a plain line.');
  });
});

describe('parseFetch snippet hygiene', () => {
  it('never leaks IMAP framing into the stored snippet', async () => {
    const { parseFetch } = await mod();
    const raw = [
      'From: SoundCloud <info@announcements.soundcloud.com>',
      'Subject: Your journey starts now',
      '',
      '* 8994 FETCH (UID 9252 BODY[TEXT] {4096}',
      '<html><body><p>Real content here</p></body></html>',
      ')',
      'a7 OK done',
    ].join('\r\n');
    const acct = { label: 'Milo Dule 3', user: 'milodule3@gmail.com', pass: 'x', host: 'h', port: 993 };
    const e = parseFetch(acct as any, 9252, raw);
    expect(e.snippet).toContain('Real content here');
    expect(e.snippet).not.toMatch(/FETCH|\{4096\}|a7 OK/);
  });
});

describe('extractReadableBody', () => {
  it('prefers the text/plain part of a multipart body', async () => {
    const { extractReadableBody } = await mod();
    const raw = [
      'From: a@b.com',
      '',
      '--BOUNDARY',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML version</p>',
      '--BOUNDARY',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain version wins',
      '--BOUNDARY--',
    ].join('\r\n');
    const out = extractReadableBody(raw);
    expect(out).toContain('Plain version wins');
    expect(out).not.toContain('HTML version');
  });

  it('decodes quoted-printable escapes and soft breaks', async () => {
    const { decodeQuotedPrintable } = await mod();
    expect(decodeQuotedPrintable('caf=C3=A9')).toBe('café');
    expect(decodeQuotedPrintable('one=\r\ntwo')).toBe('onetwo');
  });

  it('handles \\n-only line endings (as stripImapFraming produces)', async () => {
    const { extractReadableBody } = await mod();
    const out = extractReadableBody('Subject: x\n\nReal body text');
    expect(out).toBe('Real body text');
  });
});
