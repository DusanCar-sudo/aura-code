import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { run, minimalEnv, hasCommand } from '../../src/util/exec.js';
import { imageRead, sniffImage } from '../../src/tools/image-read.js';

// 1×1 transparent PNG
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-sec-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('util/exec', () => {
  it('passes shell metacharacters through as one literal argument', () => {
    const canary = path.join(dir, 'pwned');
    const evil = `"; touch ${canary}; echo "$(touch ${canary})`;
    const r = run('printf', ['%s', evil]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(evil);
    expect(fs.existsSync(canary)).toBe(false);
  });

  it('keeps provider keys and tokens out of the child environment', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-secret');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tok');
    const env = minimalEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    const r = run('sh', ['-c', 'echo "${OPENAI_API_KEY:-none}"']);
    expect(r.stdout.trim()).toBe('none');
    expect(minimalEnv({ ONLY_THIS: 'x' }).ONLY_THIS).toBe('x');
  });

  it('reports a missing program instead of throwing', () => {
    const r = run('definitely-not-a-program-aura', []);
    expect(r.error).toBeDefined();
    expect(r.status).toBeNull();
    expect(hasCommand('definitely-not-a-program-aura')).toBe(false);
    expect(hasCommand('sh')).toBe(true);
    expect(hasCommand('sh; rm -rf /')).toBe(false);
  });
});

describe('image_read', () => {
  it('does not run anything hidden in the file name', async () => {
    // a file name can't hold '/', so the injected command writes to the cwd
    const canary = path.join(process.cwd(), 'aura-pwned-canary');
    const name = path.join(dir, 'a"; touch aura-pwned-canary; echo $(touch aura-pwned-canary) ".png');
    fs.writeFileSync(name, PNG);
    await imageRead({ path: name, action: 'info' });
    await imageRead({ path: name, action: 'ocr' });
    expect(fs.existsSync(canary)).toBe(false);
  });

  it('refuses to base64 a file that is not an image, whatever its name', async () => {
    const fake = path.join(dir, 'id_ed25519.png');
    fs.writeFileSync(fake, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
    const out = await imageRead({ path: fake, action: 'base64' });
    expect(typeof out).toBe('string');
    expect(out as string).toMatch(/^Error: .*not an image/);
    expect(out as string).not.toContain('OPENSSH');
  });

  it('still attaches a real image, even under another name', async () => {
    const p = path.join(dir, 'shot.bin');
    fs.writeFileSync(p, PNG);
    const out = await imageRead({ path: p, action: 'base64' });
    expect(typeof out).toBe('object');
    expect((out as { images: string[] }).images[0]).toMatch(/^data:image\/png;base64,/);
  });

  it('sniffs the common formats', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from('ffd8ffe000104a464946', 'hex'))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="x"></svg>'))).toBe('image/svg+xml');
    expect(sniffImage(Buffer.from('{"apiKey":"x"}'))).toBeNull();
  });
});

describe('ftp_upload', () => {
  const fakeCurl = () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'curl'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  };

  it('keeps the password out of argv and the URL', async () => {
    const { ftpUpload } = await import('../../src/tools/ftp-upload.js');
    fakeCurl();
    const f = path.join(dir, 'site.html');
    fs.writeFileSync(f, '<p>hi</p>');
    const out = ftpUpload({ host: 'ftp.example.com', username: 'me', password: 'p@ss"word', remoteDir: '/htdocs/', localFile: f });
    expect(out).toMatch(/^✓ Uploaded/);
    const argv = fs.readFileSync(path.join(dir, 'argv'), 'utf8');
    expect(argv).not.toContain('p@ss');
    expect(argv).toContain('ftp://ftp.example.com:21/htdocs/');
    expect(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')).toBe('user = "me:p@ss\\"word"\n');
  });

  it('rejects values that would reshape the URL', async () => {
    const { ftpUpload } = await import('../../src/tools/ftp-upload.js');
    fakeCurl();
    const f = path.join(dir, 'x');
    fs.writeFileSync(f, 'x');
    const base = { host: 'ftp.example.com', username: 'u', password: 'p', remoteDir: '/a/', localFile: f };
    expect(ftpUpload({ ...base, host: 'evil.com/x?@ftp.example.com' })).toMatch(/^Error: invalid FTP host/);
    expect(ftpUpload({ ...base, remoteDir: '/a/ -o /etc/passwd' })).toMatch(/^Error: remoteDir/);
    expect(ftpUpload({ ...base, port: 0 })).toMatch(/^Error: invalid FTP port/);
    expect(ftpUpload({ ...base, password: 'a\nurl = "http://evil"' })).toMatch(/line breaks/);
    expect(fs.existsSync(path.join(dir, 'argv'))).toBe(false);
  });
});
