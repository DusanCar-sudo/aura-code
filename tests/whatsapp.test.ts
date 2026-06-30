import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { whatsAppTool, WHATSAPP_DEFINITION } from '../src/tools/whatsapp.js';

const testDir = path.join(os.tmpdir(), 'ruby-test-whatsapp-' + Date.now());
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
  fs.writeFileSync(path.join(configDir, 'whatsapp.json'), JSON.stringify(config));
}

describe('WHATSAPP_DEFINITION', () => {
  it('has correct name', () => expect(WHATSAPP_DEFINITION.name).toBe('whatsapp'));
  it('requires action', () => expect(WHATSAPP_DEFINITION.parameters.required).toEqual(['action']));
});

describe('whatsAppTool — no config', () => {
  it('returns error when config missing', async () => {
    const r = await whatsAppTool({ action: 'send', to: '+381641234567', message: 'hello' });
    expect(r).toContain('Error: WhatsApp not configured');
  });
});

describe('whatsAppTool — Twilio provider', () => {
  it('sends message successfully', async () => {
    writeConfig({ provider: 'twilio', account_sid: 'AC123', auth_token: 'token456', from: 'whatsapp:+14155238886' });
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ sid: 'SM123', status: 'queued' }));
    const r = await whatsAppTool({ action: 'send', to: '+381641234567', message: 'Hello!' });
    expect(r).toContain('sent');
    expect(r).toContain('SM123');
  });

  it('requires to field', async () => {
    writeConfig({ provider: 'twilio', account_sid: 'AC123', auth_token: 'token456' });
    const r = await whatsAppTool({ action: 'send', message: 'Hello!' });
    expect(r).toContain('Error: to');
  });

  it('requires message field', async () => {
    writeConfig({ provider: 'twilio', account_sid: 'AC123', auth_token: 'token456' });
    const r = await whatsAppTool({ action: 'send', to: '+381641234567' });
    expect(r).toContain('Error: message');
  });

  it('handles Twilio API error', async () => {
    writeConfig({ provider: 'twilio', account_sid: 'AC123', auth_token: 'token456' });
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ message: 'Invalid number', code: 21211 }, 400));
    const r = await whatsAppTool({ action: 'send', to: 'bad', message: 'test' });
    expect(r).toContain('Error');
  });

  it('checks status', async () => {
    writeConfig({ provider: 'twilio', account_sid: 'AC123', auth_token: 'token456' });
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ friendly_name: 'My Account', status: 'active' }));
    const r = await whatsAppTool({ action: 'status' });
    expect(r).toContain('My Account');
    expect(r).toContain('active');
  });
});

describe('whatsAppTool — Gateway provider', () => {
  it('sends message via gateway', async () => {
    writeConfig({ provider: 'gateway', url: 'http://localhost:3000/send' });
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }));
    const r = await whatsAppTool({ action: 'send', to: '+381641234567', message: 'test' });
    expect(r).toContain('sent');
    expect(r).toContain('gateway');
  });

  it('handles gateway error', async () => {
    writeConfig({ provider: 'gateway', url: 'http://localhost:3000/send' });
    mockFetch.mockResolvedValueOnce(new Response('Internal Error', { status: 500 }));
    const r = await whatsAppTool({ action: 'send', to: '+381641234567', message: 'test' });
    expect(r).toContain('Error');
  });
});
