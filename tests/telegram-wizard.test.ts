import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

// Same mocking approach already proven correct in telegram-voice.test.ts —
// Node's real exec has a util.promisify.custom implementation resolving to
// {stdout, stderr}; a plain vi.fn() callback mock doesn't replicate that on
// its own, so it has to be attached explicitly or the real code's
// `const {stdout} = await execAsync(...)` would silently destructure off
// the wrong shape during tests.
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('child_process', () => {
  const mockedExec: any = (...args: any[]) => execMock(...args);
  mockedExec[promisify.custom] = (cmd: string, opts?: any) =>
    new Promise((resolve, reject) => {
      execMock(cmd, opts, (err: any, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return { exec: mockedExec };
});

import {
  testBotToken,
  saveTelegramConfig,
  loadExistingTelegramConfig,
  telegramConfigPath,
  buildSystemdServiceContent,
} from '../src/setup/telegram-wizard.js';

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-wizard-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  execMock.mockReset();
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('testBotToken', () => {
  it('returns the username on a successful getMe response', async () => {
    execMock.mockImplementationOnce((cmd: string, _opts: any, cb: any) => {
      expect(cmd).toContain('getMe');
      cb(null, JSON.stringify({ ok: true, result: { username: 'MyTestBot' } }), '');
    });
    const result = await testBotToken('fake-token');
    expect(result).toBe('MyTestBot');
  });

  it('returns null on an invalid token response', async () => {
    execMock.mockImplementationOnce((_cmd: string, _opts: any, cb: any) => {
      cb(null, JSON.stringify({ ok: false, description: 'Unauthorized' }), '');
    });
    const result = await testBotToken('bad-token');
    expect(result).toBeNull();
  });

  it('returns null (not a throw) if curl itself fails', async () => {
    execMock.mockImplementationOnce((_cmd: string, _opts: any, cb: any) => {
      cb(new Error('curl: command not found'), '', '');
    });
    const result = await testBotToken('fake-token');
    expect(result).toBeNull();
  });

  it('returns null on unparseable output rather than throwing', async () => {
    execMock.mockImplementationOnce((_cmd: string, _opts: any, cb: any) => {
      cb(null, 'not json', '');
    });
    const result = await testBotToken('fake-token');
    expect(result).toBeNull();
  });
});

describe('saveTelegramConfig / loadExistingTelegramConfig', () => {
  it('writes to ~/.aura/telegram.json and reads it back correctly', () => {
    saveTelegramConfig('123:ABC', ['111', '222']);
    const expectedPath = path.join(tmpHome, '.aura', 'telegram.json');
    expect(telegramConfigPath()).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);

    const loaded = loadExistingTelegramConfig();
    expect(loaded?.bot_token).toBe('123:ABC');
    expect(loaded?.allowed_user_ids).toBe('111,222');
  });

  it('returns null when no config exists yet', () => {
    expect(loadExistingTelegramConfig()).toBeNull();
  });

  it('writes the file with restrictive permissions (contains a real token)', () => {
    saveTelegramConfig('123:ABC', ['111']);
    const stat = fs.statSync(telegramConfigPath());
    // 0o600 = owner read/write only
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('buildSystemdServiceContent', () => {
  const baseInputs = { allowedUserIds: ['111', '222'] };

  it('includes the correct ExecStart using the real node path and script path', () => {
    const content = buildSystemdServiceContent(baseInputs, '/usr/bin/node', '/home/x/dist/tools/telegram-bot.js', '/home/x', '/home/x/.aura/log');
    expect(content).toContain('ExecStart=/usr/bin/node /home/x/dist/tools/telegram-bot.js');
    expect(content).toContain('WorkingDirectory=/home/x');
  });

  it('includes the allowed user IDs as a comma-separated env var', () => {
    const content = buildSystemdServiceContent(baseInputs, 'node', 'bot.js', '/x', '/x/log');
    expect(content).toContain('Environment="TELEGRAM_BOT_ALLOWED_USER_IDS=111,222"');
  });

  it('includes the task model and the CORRECT matching API key env var, not a wrong one', () => {
    const content = buildSystemdServiceContent(
      { ...baseInputs, taskModel: 'mimo-v2.5-pro', providerApiKey: 'tp-realkey' },
      'node', 'bot.js', '/x', '/x/log',
    );
    expect(content).toContain('Environment="TELEGRAM_BOT_MODEL=mimo-v2.5-pro"');
    // This is the exact class of bug fixed earlier — the env var must match
    // the model's actual provider family, not just be present at all.
    expect(content).toContain('Environment="XIAOMI_API_KEY=tp-realkey"');
    expect(content).not.toContain('DEEPSEEK_API_KEY');
  });

  it('maps a deepseek model to DEEPSEEK_API_KEY, not XIAOMI_API_KEY', () => {
    const content = buildSystemdServiceContent(
      { ...baseInputs, taskModel: 'deepseek/deepseek-v4-flash', providerApiKey: 'sk-realkey' },
      'node', 'bot.js', '/x', '/x/log',
    );
    expect(content).toContain('Environment="DEEPSEEK_API_KEY=sk-realkey"');
    expect(content).not.toContain('XIAOMI_API_KEY');
  });

  it('omits the provider API key line entirely if no key was provided, even with a model set', () => {
    const content = buildSystemdServiceContent(
      { ...baseInputs, taskModel: 'mimo-v2.5-pro' },
      'node', 'bot.js', '/x', '/x/log',
    );
    expect(content).toContain('TELEGRAM_BOT_MODEL=mimo-v2.5-pro');
    expect(content).not.toContain('XIAOMI_API_KEY');
  });

  it('includes GROQ_API_KEY only when voice support was actually configured', () => {
    const withGroq = buildSystemdServiceContent({ ...baseInputs, groqKey: 'gsk-real' }, 'node', 'bot.js', '/x', '/x/log');
    const withoutGroq = buildSystemdServiceContent(baseInputs, 'node', 'bot.js', '/x', '/x/log');
    expect(withGroq).toContain('Environment="GROQ_API_KEY=gsk-real"');
    expect(withoutGroq).not.toContain('GROQ_API_KEY');
  });

  it('always includes Restart=always so the bot recovers from a crash', () => {
    const content = buildSystemdServiceContent(baseInputs, 'node', 'bot.js', '/x', '/x/log');
    expect(content).toContain('Restart=always');
  });

  it('points StandardOutput/StandardError at the given log path', () => {
    const content = buildSystemdServiceContent(baseInputs, 'node', 'bot.js', '/x', '/custom/log/path');
    expect(content).toContain('StandardOutput=append:/custom/log/path');
    expect(content).toContain('StandardError=append:/custom/log/path');
  });
});
