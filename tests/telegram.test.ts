import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { telegramTool, TELEGRAM_DEFINITION } from '../src/tools/telegram.js';

const testDir = path.join(os.tmpdir(), 'ruby-test-telegram-' + Date.now());
const configDir = path.join(testDir, '.aura');

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  process.env.HOME = testDir;
  fs.mkdirSync(configDir, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(testDir, { recursive: true, force: true });
});

function mockJsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function writeConfig(config: any) {
  fs.writeFileSync(path.join(configDir, 'telegram.json'), JSON.stringify(config));
}

describe('TELEGRAM_DEFINITION', () => {
  it('has correct name', () => expect(TELEGRAM_DEFINITION.name).toBe('telegram'));
  it('requires action', () => expect(TELEGRAM_DEFINITION.parameters.required).toEqual(['action']));
});

describe('telegramTool — no config', () => {
  it('returns error when config missing', async () => {
    const r = await telegramTool({ action: 'send', text: 'hello' });
    expect(r).toContain('Error: Telegram not configured');
    expect(r).toContain('@BotFather');
  });
});

describe('telegramTool — send', () => {
  it('requires chat_id when no default', async () => {
    writeConfig({ bot_token: 'fake:token' });
    const r = await telegramTool({ action: 'send', text: 'hello' });
    expect(r).toContain('Error: chat_id');
  });

  it('requires text', async () => {
    writeConfig({ bot_token: 'fake:token', default_chat_id: '12345' });
    const r = await telegramTool({ action: 'send' });
    expect(r).toContain('Error: text');
  });

  it('sends message successfully', async () => {
    writeConfig({ bot_token: 'fake:token', default_chat_id: '12345' });
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true, result: { message_id: 42 } }));
    const r = await telegramTool({ action: 'send', text: 'Hello from Aura!' });
    expect(r).toContain('Message sent');
    expect(r).toContain('42');
  });

  it('uses custom chat_id over default', async () => {
    writeConfig({ bot_token: 'fake:token', default_chat_id: '11111' });
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true, result: { message_id: 1 } }));
    await telegramTool({ action: 'send', text: 'test', chat_id: '99999' });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.chat_id).toBe('99999');
  });

  it('handles API error', async () => {
    writeConfig({ bot_token: 'fake:token', default_chat_id: '12345' });
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: false, description: 'Bad Request: chat not found', error_code: 400 }));
    const r = await telegramTool({ action: 'send', text: 'test' });
    expect(r).toContain('error');
    expect(r).toContain('chat not found');
  });
});

describe('telegramTool — get_updates', () => {
  it('returns no updates message', async () => {
    writeConfig({ bot_token: 'fake:token' });
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true, result: [] }));
    const r = await telegramTool({ action: 'get_updates' });
    expect(r).toContain('No new updates');
  });

  it('parses updates correctly', async () => {
    writeConfig({ bot_token: 'fake:token' });
    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      ok: true,
      result: [{
        update_id: 100,
        message: {
          message_id: 1,
          from: { first_name: 'Dušan', username: 'dusan' },
          chat: { id: 12345 },
          text: 'Hello bot!',
          date: 1718000000,
        },
      }],
    }));
    const r = await telegramTool({ action: 'get_updates' });
    expect(r).toContain('Dušan');
    expect(r).toContain('Hello bot!');
    expect(r).toContain('12345');
  });
});

describe('telegramTool — info', () => {
  it('returns bot info', async () => {
    writeConfig({ bot_token: 'fake:token' });
    mockFetch.mockResolvedValueOnce(mockJsonResponse({
      ok: true,
      result: { id: 123456, first_name: 'AuraBot', username: 'aura_bot', can_join_groups: true, can_read_all_group_messages: false },
    }));
    const r = await telegramTool({ action: 'info' });
    expect(r).toContain('AuraBot');
    expect(r).toContain('aura_bot');
  });
});

describe('telegramTool — send_photo', () => {
  it('requires photo', async () => {
    writeConfig({ bot_token: 'fake:token', default_chat_id: '12345' });
    const r = await telegramTool({ action: 'send_photo' });
    expect(r).toContain('Error: photo');
  });

  it('sends photo successfully', async () => {
    writeConfig({ bot_token: 'fake:token', default_chat_id: '12345' });
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true, result: { message_id: 99 } }));
    const r = await telegramTool({ action: 'send_photo', photo: 'https://example.com/image.png', caption: 'Look!' });
    expect(r).toContain('Photo sent');
  });
});
