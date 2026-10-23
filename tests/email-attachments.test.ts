import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emailTool, EMAIL_DEFINITION, buildMultipart } from '../src/tools/email.js';

// No test may ever reach a real mail binary — hasCommand must answer "none".
vi.mock('../src/util/exec.js', () => ({
  hasCommand: () => false,
  run: () => ({ status: 127, stdout: '', stderr: '', error: new Error('not found') }),
}));

describe('EMAIL_DEFINITION — attachments', () => {
  it('exposes attachments as an array of file paths', () => {
    const props = EMAIL_DEFINITION.parameters.properties as Record<string, { type: string; items?: { type: string } }>;
    expect(props.attachments).toBeDefined();
    expect(props.attachments.type).toBe('array');
    expect(props.attachments.items?.type).toBe('string');
  });
});

describe('emailTool — send with attachments', () => {
  it('errors when an attachment does not exist', async () => {
    const r = await emailTool({
      action: 'send',
      to: 'a@b.com',
      subject: 's',
      body: 'b',
      attachments: ['/nonexistent/nowhere/nope.html'],
    });
    expect(r).toContain('attachment not found');
    expect(r).toContain('nope.html');
  });
});

describe('buildMultipart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-att-'));
  const file = path.join(dir, 'brief.html');
  fs.writeFileSync(file, '<h1>hi</h1>');

  it('builds a multipart/mixed message with a base64 attachment part', () => {
    const msg = buildMultipart(['To: a@b.com', 'Subject: s'], 'plain body', [file], '\n');
    expect(msg).toBeTruthy();
    expect(msg!).toContain('Content-Type: multipart/mixed; boundary=');
    expect(msg!).toContain('Content-Disposition: attachment; filename="brief.html"');
    expect(msg!).toContain('Content-Transfer-Encoding: base64');
    expect(msg!).toContain(Buffer.from('<h1>hi</h1>').toString('base64'));
    expect(msg!).toContain('plain body');
    expect(msg!).toMatch(/--aura-boundary-[^\s"]+/);
    // parts close cleanly
    expect(msg!.trimEnd().endsWith('--')).toBe(true);
  });

  it('returns null when an attachment is missing', () => {
    expect(buildMultipart(['To: a@b.com'], 'x', [path.join(dir, 'missing.html')], '\n')).toBeNull();
  });

  it('uses the basename only, never the directory', () => {
    const msg = buildMultipart(['To: a@b.com'], 'x', [file], '\n')!;
    expect(msg).toContain('filename="brief.html"');
    expect(msg).not.toContain(dir);
  });

  it('wraps base64 at 76 columns', () => {
    const big = path.join(dir, 'big.txt');
    fs.writeFileSync(big, 'x'.repeat(200));
    const msg = buildMultipart(['To: a@b.com'], 'x', [big], '\n')!;
    const b64Lines = msg.split('\n').filter(l => /^[A-Za-z0-9+/=]+$/.test(l) && l.length > 76);
    expect(b64Lines).toHaveLength(0);
  });
});
