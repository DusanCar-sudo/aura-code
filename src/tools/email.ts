import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolDefinition } from '../providers/types.js';
import { auraPath } from '../util/aura-home.js';
import { run, hasCommand } from '../util/exec.js';

// ─────────────────────────────────────────────────────────────────────────────
// Email — send and read emails (system mail or configured SMTP)
// ─────────────────────────────────────────────────────────────────────────────

export interface EmailInput {
  action: 'send' | 'read' | 'unread_count';
  to?: string;
  subject?: string;
  body?: string;
  cc?: string;
  limit?: number;
}

export const EMAIL_DEFINITION: ToolDefinition = {
  name: 'email',
  description:
    'Send and read emails. Uses system mail (sendmail/msmtp) or configured SMTP. ' +
    'For reading, uses local mailbox. Configure ~/.msmtprc or ~/.aura/email.json for SMTP.',
  parameters: {
    type: 'object',
    properties: {
      action:  { type: 'string', description: 'Action: send, read, unread_count' },
      to:      { type: 'string', description: 'Recipient email (for send)' },
      subject: { type: 'string', description: 'Email subject (for send)' },
      body:    { type: 'string', description: 'Email body (for send)' },
      cc:      { type: 'string', description: 'CC recipients (for send)' },
      limit:   { type: 'number', description: 'Max emails to read (default: 10)' },
    },
    required: ['action'],
  },
};

function getConfig(): { smtp_host?: string; smtp_port?: number; smtp_user?: string; smtp_pass?: string; from?: string } | null {
  const configPath = auraPath('email.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Comma-separated addresses → a list, or null if any isn't a plain address. */
export function parseRecipients(to: string): string[] | null {
  const list = to.split(',').map(a => a.trim()).filter(Boolean);
  const ok = list.length > 0 && list.every(a => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(a));
  return ok ? list : null;
}

/**
 * Hand the message to a local mail program. It used to be
 * `echo "<message>" | msmtp <to>`: $(…) in the body ran, and `to` went into
 * the command unquoted. Now the message is stdin and the addresses are
 * argv, each checked to be an address.
 */
export function sendViaCommand(to: string, subject: string, body: string): string {
  const rcpts = parseRecipients(to);
  if (!rcpts) return `Error: not a valid recipient list: ${to}`;
  // a line break in a header would start a new header (hidden Bcc, etc.)
  if (/[\r\n]/.test(subject)) return 'Error: subject cannot contain line breaks';
  const message = `To: ${rcpts.join(', ')}\nSubject: ${subject}\nContent-Type: text/plain; charset=UTF-8\n\n${body}`;

  const attempts: Array<[string, string[], string]> = [
    ['msmtp', ['--', ...rcpts], message],
    ['sendmail', ['-t'], message],
    ['mail', ['-s', subject, '--', ...rcpts], body],
  ];
  for (const [bin, args, input] of attempts) {
    if (!hasCommand(bin)) continue;
    const r = run(bin, args, { input, timeoutMs: 60_000 });
    if (!r.error && r.status === 0) return `Email sent to ${rcpts.join(', ')} via ${bin}: "${subject}"`;
  }

  return 'Error: No mail command found. Install msmtp, sendmail, or mailutils. Or configure ~/.aura/email.json';
}

function readMail(limit: number): string {
  // Try reading from local mailbox
  const mailPaths = [
    path.join(os.homedir(), 'Mail', 'inbox'),
    '/var/mail/' + os.userInfo().username,
    path.join(os.homedir(), '.mail'),
  ];

  for (const p of mailPaths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        if (!content.trim()) return 'Inbox is empty.';

        // Split by mail separators
        const emails = content.split(/^(?=From )/m).filter(e => e.trim());
        const recent = emails.slice(-limit);
        return `Found ${emails.length} emails (showing last ${recent.length}):\n\n${recent.join('\n---\n')}`;
      } catch (e: any) {
        return `Error reading mailbox: ${e?.message}`;
      }
    }
  }

  return 'No local mailbox found. Configure ~/.aura/email.json or use a mail client.';
}

function unreadCount(): string {
  try {
    // Try notmuch
    execSync('which notmuch', { stdio: 'pipe' });
    const count = execSync('notmuch count tag:unread', { encoding: 'utf8' }).trim();
    return `Unread emails: ${count}`;
  } catch { /* not found */ }

  // Fallback to reading
  return 'Cannot count unread emails. Install notmuch or configure mail client.';
}

export async function emailTool(input: EmailInput): Promise<string> {
  switch (input.action) {
    case 'send': {
      if (!input.to) return 'Error: to is required for send';
      if (!input.subject) return 'Error: subject is required for send';
      if (!input.body) return 'Error: body is required for send';
      return sendViaCommand(input.to, input.subject, input.body);
    }

    case 'read': {
      return readMail(input.limit ?? 10);
    }

    case 'unread_count': {
      return unreadCount();
    }

    default:
      return `Error: Unknown email action: ${input.action}`;
  }
}
