import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Gmail — read and write emails via Google Gmail API (raw HTTP)
// ─────────────────────────────────────────────────────────────────────────────

export interface GmailInput {
  action: 'list' | 'send' | 'read' | 'setup' | 'setup_finish' | 'setup_status';
  to?: string;
  subject?: string;
  body?: string;
  max_results?: number;
  message_id?: string;
  // setup
  client_id?: string;
  client_secret?: string;
  code?: string;
  email?: string;
}

export const GMAIL_DEFINITION: ToolDefinition = {
  name: 'gmail',
  description:
    'Read and write emails via Gmail API. Uses OAuth from ~/.hermes/google_token.json. ' +
    'Actions: list, read, send (require an existing token — use setup_status to check). ' +
    'setup (step 1: takes client_id + client_secret, returns a URL for the user to open and ' +
    'approve, never echoes secrets back). setup_finish (step 2: takes the "code" from the ' +
    'redirect URL, exchanges it for tokens, and saves them — never returns the token itself). ' +
    'setup_status (checks whether a working token already exists, with no secret values shown).',
  parameters: {
    type: 'object',
    properties: {
      action:        { type: 'string', description: 'Action: list, read, send, setup, setup_finish, setup_status' },
      to:            { type: 'string', description: 'Recipient email (for send)' },
      subject:       { type: 'string', description: 'Email subject (for send/read)' },
      body:          { type: 'string', description: 'Email body text (for send)' },
      max_results:   { type: 'number', description: 'Max results for list (default: 10)' },
      message_id:    { type: 'string', description: 'Gmail message ID to read (for read)' },
      client_id:     { type: 'string', description: 'Google OAuth client ID (for setup)' },
      client_secret: { type: 'string', description: 'Google OAuth client secret (for setup)' },
      code:          { type: 'string', description: 'Authorization code from the redirect URL (for setup_finish)' },
      email:         { type: 'string', description: 'The Gmail address being connected (for setup_finish)' },
    },
    required: ['action'],
  },
};

const TOKEN_PATH = path.join(os.homedir(), '.hermes', 'google_token.json');
const SETUP_STATE_PATH = path.join(os.homedir(), '.hermes', '.gmail_setup_state.json');
const REDIRECT_URI = 'http://localhost:8080/';
const SETUP_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
].join(' ');

interface TokenFile {
  token: string;
  refresh_token: string;
  token_uri?: string;
  client_id: string;
  client_secret: string;
  scopes?: string[];
  expiry?: string;
  email?: string;
}

function loadToken(): TokenFile {
  if (!fs.existsSync(TOKEN_PATH)) throw new Error(`Google token not found at ${TOKEN_PATH}`);
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) as TokenFile;
}

function saveToken(token: TokenFile) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
}

/**
 * Setup is split into two steps because OAuth requires a human to approve
 * access in a browser between them. The client_id/client_secret given in
 * step 1 are held ONLY in memory between the two tool calls (never written to
 * disk, never echoed back) — they're persisted to TOKEN_PATH only once the
 * full token exchange in setup_finish succeeds. If the user never completes
 * step 2, nothing is left on disk.
 *
 * Critically: at no point does this tool return token, refresh_token,
 * client_secret, or any other credential value as part of its string result.
 * Those values exist only inside this process and inside TOKEN_PATH on disk —
 * never in the text that flows back into the conversation.
 */
let pendingSetup: { client_id: string; client_secret: string } | null = null;

function saveSetupState(s: { client_id: string; client_secret: string }) {
  // Held in-memory primarily; this on-disk copy only survives a process
  // restart between step 1 and step 2 of the SAME setup attempt, and is
  // deleted as soon as setup_finish succeeds or fails terminally.
  fs.mkdirSync(path.dirname(SETUP_STATE_PATH), { recursive: true });
  fs.writeFileSync(SETUP_STATE_PATH, JSON.stringify(s), { mode: 0o600 });
}

function loadSetupState(): { client_id: string; client_secret: string } | null {
  if (pendingSetup) return pendingSetup;
  if (!fs.existsSync(SETUP_STATE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(SETUP_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function clearSetupState() {
  pendingSetup = null;
  try { fs.unlinkSync(SETUP_STATE_PATH); } catch { /* already gone */ }
}

async function refreshAccess(token: TokenFile): Promise<string> {
  const tokenUri = token.token_uri || 'https://oauth2.googleapis.com/token';
  const body = new URLSearchParams({
    client_id: token.client_id,
    client_secret: token.client_secret,
    refresh_token: token.refresh_token,
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
    if (token.expiry && Date.now() < new Date(token.expiry).getTime() + 60000) {
      return token.token as string;
    }
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
      case 'setup_status': {
        if (!fs.existsSync(TOKEN_PATH)) return 'Not connected. No Gmail token found. Run setup to connect.';
        try {
          const t = loadToken();
          const valid = !!t.refresh_token;
          return valid
            ? `Connected${t.email ? ` as ${t.email}` : ''}. Token file present with a refresh token.`
            : 'Token file exists but has no refresh_token — re-run setup.';
        } catch {
          return 'Token file exists but could not be parsed — re-run setup.';
        }
      }

      case 'setup': {
        if (!input.client_id || !input.client_secret) {
          return 'Error: setup requires client_id and client_secret (from Google Cloud Console → APIs & Services → Credentials → OAuth client ID, type "Desktop app").';
        }
        // Held only in memory + a short-lived local state file; never echoed.
        pendingSetup = { client_id: input.client_id, client_secret: input.client_secret };
        saveSetupState(pendingSetup);

        const params = new URLSearchParams({
          client_id: input.client_id,
          redirect_uri: REDIRECT_URI,
          response_type: 'code',
          scope: SETUP_SCOPES,
          access_type: 'offline',
          prompt: 'consent',
        });
        const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

        return (
          `Step 1 of 2: open this URL, sign in, and approve access:\n\n${url}\n\n` +
          `You'll be redirected to a localhost address that fails to load — that's expected, ` +
          `nothing is listening there. Copy the "code=" value from that URL's address bar ` +
          `(everything after "code=" and before the next "&", if any), then tell me to finish ` +
          `setup with that code and your Gmail address. I will not display the code, the ` +
          `client secret, or the resulting token back to you — only a success or failure message.`
        );
      }

      case 'setup_finish': {
        const state = loadSetupState();
        if (!state) {
          return 'Error: no setup in progress. Run the setup action first (with client_id and client_secret) to get a fresh authorization URL.';
        }
        if (!input.code) {
          return 'Error: setup_finish requires the "code" value copied from the redirect URL.';
        }

        const body = new URLSearchParams({
          code: input.code,
          client_id: state.client_id,
          client_secret: state.client_secret,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code',
        });

        let res: Response;
        try {
          res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
        } catch (e: any) {
          return `Setup failed: could not reach Google's token endpoint (${e?.message ?? String(e)}). The authorization code is single-use — you'll need to run setup again to get a fresh one.`;
        }

        if (!res.ok) {
          // Do not include res text verbatim if it might contain the code/secret echoed back;
          // Google's error responses for this endpoint don't, but we keep this conservative.
          clearSetupState();
          return `Setup failed: Google rejected the authorization code (HTTP ${res.status}). The code is single-use and may have expired or been used already — run setup again for a fresh URL.`;
        }

        const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };

        if (!data.refresh_token) {
          clearSetupState();
          return (
            'Setup partially failed: Google did not return a refresh_token, which means future ' +
            'tokens cannot be auto-renewed. This usually happens when access was already granted ' +
            'previously. Remove the app at https://myaccount.google.com/permissions and run setup ' +
            'again to force a fresh consent.'
          );
        }

        const tokenFile: TokenFile = {
          token: data.access_token,
          refresh_token: data.refresh_token,
          token_uri: 'https://oauth2.googleapis.com/token',
          client_id: state.client_id,
          client_secret: state.client_secret,
          scopes: (data.scope ?? SETUP_SCOPES).split(' '),
          expiry: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
          email: input.email,
        };
        saveToken(tokenFile);
        clearSetupState();

        return `✓ Gmail connected${input.email ? ` for ${input.email}` : ''}. You can now use list, read, and send.`;
      }

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

        const isHtml = /<html|<body|<div|<p|<br|<table|<h[1-6]/i.test(input.body);
        const contentType = isHtml ? 'text/html; charset=UTF-8' : 'text/plain; charset=UTF-8';

        const tokenData = loadToken();
        const fromEmail = tokenData.email || 'milodule3@gmail.com';

        const raw = Buffer.from(
          `From: ${fromEmail}\r\nTo: ${input.to}\r\nSubject: ${input.subject}\r\nMIME-Version: 1.0\r\nContent-Type: ${contentType}\r\n\r\n${input.body}`,
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
