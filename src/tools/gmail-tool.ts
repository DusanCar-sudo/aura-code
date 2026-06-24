import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Gmail — read and write emails via Google Gmail API (raw HTTP)
// ─────────────────────────────────────────────────────────────────────────────

export interface GmailInput {
  action: 'list' | 'send' | 'read';
  to?: string;
  subject?: string;
  body?: string;
  max_results?: number;
  message_id?: string;
}

export const GMAIL_DEFINITION: ToolDefinition = {
  name: 'gmail',
  description:
    'Read and write emails via Gmail API. Uses existing Google OAuth from ~/.hermes/google_token.json. ' +
    'Actions: list (recent emails), read (full message by id), send (compose new email).',
  parameters: {
    type: 'object',
    properties: {
      action:     { type: 'string', description: 'Action: list, read, send' },
      to:         { type: 'string', description: 'Recipient email (for send)' },
      subject:    { type: 'string', description: 'Email subject (for send/read)' },
      body:       { type: 'string', description: 'Email body text (for send)' },
      max_results:{ type: 'number', description: 'Max results for list (default: 10)' },
      message_id: { type: 'string', description: 'Gmail message ID to read (for read)' },
    },
    required: ['action'],
  },
};

const TOKEN_PATH = path.join(os.homedir(), '.hermes', 'google_token.json');

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) throw new Error(`Google token not found at ${TOKEN_PATH}`);
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) as {
    token: string;
    refresh_token: string;
    token_uri?: string;
    client_id: string;
    client_secret: string;
    scopes?: string[];
    expiry?: string;
  };
}

function saveToken(token: Record<string, unknown>) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

async function refreshAccess(token: Record<string, unknown>): Promise<string> {
  const tokenUri = (token.token_uri as string) || 'https://oauth2.googleapis.com/token';
  const body = new URLSearchParams({
    client_id: token.client_id as string,
    client_secret: token.client_secret as string,
    refresh_token: token.refresh_token as string,
    grant_type: 'refresh_token',
  });

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  token.token = data.access_token;
  if (data.expires_in) {
    token.expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
  }
  saveToken(token);
  return data.access_token;
}

async function getValidToken(): Promise<string> {
  const token = loadToken();
  if (token.token) {
    // If expiry present and still valid, use it
    if (token.expiry && Date.now() < new Date(token.expiry).getTime() + 60000) {
      return token.token as string;
    }
    // Try the token anyway; if 401, we'll refresh on auth error below
    token.token as string;
  }
  if (!token.refresh_token) throw new Error('No refresh_token available to obtain a new access token');
  return refreshAccess(token);
}

async function gmailApi<T>(path: string, init?: RequestInit & { expectJson?: true }): Promise<T>;
async function gmailApi(path: string, init?: RequestInit & { expectJson?: false }): Promise<string>;
async function gmailApi(path: string, init?: RequestInit) {
  const expectJson = (init as any)?.expectJson ?? true;
  delete (init as any)?.expectJson;

  let token = await getValidToken();
  const base = 'https://www.googleapis.com/gmail/v1';

  let res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });

  if (res.status === 401) {
    // Refresh and retry once
    const tokenData = loadToken();
    if (tokenData.refresh_token) {
      token = await refreshAccess(tokenData);
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.headers || {}),
        },
      });
    }
  }

  if (res.status === 204) {
    return '' as any;
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gmail API error ${res.status}: ${text}`);
  }
  return expectJson ? JSON.parse(text) : (text as any);
}

function decodeBase64Url(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf8');
}

function extractPlainBody(msg: any): string {
  if (msg.payload?.parts) {
    const plain = msg.payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (plain?.body?.data) return decodeBase64Url(plain.body.data);
    // multipart container without direct data
    for (const p of msg.payload.parts) {
      if (p.parts) {
        const nested = p.parts.find((n: any) => n.mimeType === 'text/plain' && n.body?.data);
        if (nested) return decodeBase64Url(nested.body.data);
      }
    }
  }
  if (msg.payload?.body?.data) return decodeBase64Url(msg.payload.body.data);
  return '(empty body)';
}

export async function gmailTool(input: GmailInput): Promise<string> {
  try {
    switch (input.action) {
      case 'list': {
        const max = input.max_results ?? 10;
        const data = (await gmailApi<{ messages?: { id: string }[] }>(
          `/users/me/messages?maxResults=${max}${input.subject ? `&q=subject:${encodeURIComponent(input.subject)}` : ''}`
        )) as { messages?: { id: string }[] };

        const messages = data.messages ?? [];
        if (messages.length === 0) return 'No emails found.';

        const summaries: string[] = [];
        for (const m of messages.slice(0, max)) {
          const msg = (await gmailApi(`/users/me/messages/${m.id}`)) as any;
          const headers: Array<{ name?: string; value?: string }> = msg.payload?.headers ?? [];
          const h = (name: string) => headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
          summaries.push(`ID: ${m.id}\nFrom: ${h('From')}\nSubject: ${h('Subject')}\nDate: ${h('Date')}`);
        }
        return `Found ${summaries.length} emails:\n\n${summaries.join('\n---\n')}`;
      }

      case 'read': {
        if (!input.message_id) return 'Error: message_id is required for read';
        const msg = (await gmailApi(`/users/me/messages/${input.message_id}`)) as any;
        const headers: Array<{ name?: string; value?: string }> = msg.payload?.headers ?? [];
        const h = (name: string) => headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
        const body = extractPlainBody(msg);
        return `From: ${h('From')}\nTo: ${h('To')}\nSubject: ${h('Subject')}\nDate: ${h('Date')}\n\n${body}`;
      }

      case 'send': {
        if (!input.to) return 'Error: to is required for send';
        if (!input.subject) return 'Error: subject is required for send';
        if (!input.body) return 'Error: body is required for send';

        const raw = Buffer.from(
          `To: ${input.to}\r\nSubject: ${input.subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${input.body}`,
        ).toString('base64url');

        const data = (await gmailApi<{ id: string }>('/users/me/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }),
        })) as { id?: string };

        return `Email sent to ${input.to}: "${input.subject}"${data.id ? ` (ID: ${data.id})` : ''}`;
      }

      default:
        return `Error: Unknown gmail action: ${input.action}`;
    }
  } catch (e: any) {
    return `Gmail error: ${e?.message ?? String(e)}`;
  }
}
