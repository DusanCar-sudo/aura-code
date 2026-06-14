import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp — send messages via Twilio WhatsApp API or HTTP gateway
// ─────────────────────────────────────────────────────────────────────────────

export interface WhatsAppInput {
  action: 'send' | 'send_media' | 'status';
  to?: string;
  message?: string;
  media_url?: string;
  from?: string;
}

export const WHATSAPP_DEFINITION: ToolDefinition = {
  name: 'whatsapp',
  description:
    'Send WhatsApp messages via Twilio API or configured HTTP gateway. ' +
    'Configure ~/.aura/whatsapp.json with { "provider": "twilio", "account_sid": "...", "auth_token": "...", "from": "whatsapp:+14155238886" }. ' +
    'Or { "provider": "gateway", "url": "http://localhost:3000/send" }.',
  parameters: {
    type: 'object',
    properties: {
      action:    { type: 'string', description: 'Action: send, send_media, status' },
      to:        { type: 'string', description: 'Recipient phone number with country code (e.g., +381641234567)' },
      message:   { type: 'string', description: 'Message text' },
      media_url: { type: 'string', description: 'URL of media to send (for send_media)' },
      from:      { type: 'string', description: 'Sender WhatsApp number (overrides config)' },
    },
    required: ['action'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

interface WhatsAppConfig {
  provider: 'twilio' | 'gateway';
  // Twilio
  account_sid?: string;
  auth_token?: string;
  from?: string;
  // Gateway
  url?: string;
  api_key?: string;
}

function loadConfig(): WhatsAppConfig | null {
  const p = path.join(os.homedir(), '.aura', 'whatsapp.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Providers
// ─────────────────────────────────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  // Ensure it starts with + and has whatsapp: prefix for Twilio
  const cleaned = phone.replace(/\s/g, '');
  if (cleaned.startsWith('whatsapp:')) return cleaned;
  return `whatsapp:${cleaned.startsWith('+') ? cleaned : '+' + cleaned}`;
}

async function sendViaTwilio(config: WhatsAppConfig, to: string, message: string, from?: string): Promise<string> {
  if (!config.account_sid || !config.auth_token) {
    return 'Error: Twilio account_sid and auth_token required in config';
  }

  const fromNumber = normalizePhone(from ?? config.from ?? '');
  const toNumber = normalizePhone(to);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.account_sid}/Messages.json`;
  const params = new URLSearchParams({
    From: fromNumber,
    To: toNumber,
    Body: message,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${config.account_sid}:${config.auth_token}`).toString('base64'),
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await response.json() as any;

  if (!response.ok) {
    return `Error: Twilio API error: ${data.message ?? 'Unknown error'} (code: ${data.code})`;
  }

  return `WhatsApp message sent to ${to} (SID: ${data.sid}, status: ${data.status})`;
}

async function sendViaTwilioMedia(config: WhatsAppConfig, to: string, message: string, mediaUrl: string, from?: string): Promise<string> {
  if (!config.account_sid || !config.auth_token) {
    return 'Error: Twilio account_sid and auth_token required in config';
  }

  const fromNumber = normalizePhone(from ?? config.from ?? '');
  const toNumber = normalizePhone(to);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.account_sid}/Messages.json`;
  const params = new URLSearchParams({
    From: fromNumber,
    To: toNumber,
    Body: message,
    MediaUrl: mediaUrl,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${config.account_sid}:${config.auth_token}`).toString('base64'),
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await response.json() as any;

  if (!response.ok) {
    return `Error: Twilio API error: ${data.message ?? 'Unknown error'}`;
  }

  return `WhatsApp media sent to ${to} (SID: ${data.sid})`;
}

async function sendViaGateway(config: WhatsAppConfig, to: string, message: string): Promise<string> {
  if (!config.url) return 'Error: Gateway URL required in config';

  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.api_key ? { 'Authorization': `Bearer ${config.api_key}` } : {}),
    },
    body: JSON.stringify({ to, message }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Gateway returned HTTP ${response.status}: ${text.slice(0, 200)}`;
  }

  return `WhatsApp message sent to ${to} via gateway`;
}

async function checkStatus(config: WhatsAppConfig): Promise<string> {
  if (config.provider === 'twilio') {
    if (!config.account_sid || !config.auth_token) return 'Error: Twilio credentials not configured';
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.account_sid}.json`;
    const response = await fetch(url, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${config.account_sid}:${config.auth_token}`).toString('base64'),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return 'Error: Cannot connect to Twilio';
    const data = await response.json() as any;
    return `Twilio connected. Account: ${data.friendly_name} (${data.status})`;
  }

  if (config.provider === 'gateway') {
    try {
      const response = await fetch(config.url!.replace(/\/send$/, '/health'), { signal: AbortSignal.timeout(5000) });
      return response.ok ? 'Gateway is reachable' : `Gateway returned HTTP ${response.status}`;
    } catch {
      return 'Gateway is not reachable';
    }
  }

  return 'Error: Unknown provider';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main executor
// ─────────────────────────────────────────────────────────────────────────────

export async function whatsAppTool(input: WhatsAppInput): Promise<string> {
  const config = loadConfig();
  if (!config) {
    return 'Error: WhatsApp not configured. Create ~/.aura/whatsapp.json with { "provider": "twilio", "account_sid": "...", "auth_token": "...", "from": "whatsapp:+14155238886" } or { "provider": "gateway", "url": "http://localhost:3000/send" }.';
  }

  try {
    switch (input.action) {
      case 'send': {
        if (!input.to) return 'Error: to (phone number) required';
        if (!input.message) return 'Error: message required';
        if (config.provider === 'twilio') return await sendViaTwilio(config, input.to, input.message, input.from);
        if (config.provider === 'gateway') return await sendViaGateway(config, input.to, input.message);
        return 'Error: Unknown provider in config';
      }

      case 'send_media': {
        if (!input.to) return 'Error: to required';
        if (!input.message) return 'Error: message required';
        if (!input.media_url) return 'Error: media_url required';
        if (config.provider === 'twilio') return await sendViaTwilioMedia(config, input.to, input.message, input.media_url, input.from);
        return 'Error: send_media only supported for Twilio provider';
      }

      case 'status': {
        return await checkStatus(config);
      }

      default:
        return `Error: Unknown whatsapp action: ${input.action}`;
    }
  } catch (e: any) {
    return `WhatsApp error (${input.action}): ${e?.message ?? String(e)}`;
  }
}
