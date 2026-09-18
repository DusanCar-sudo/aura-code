import { run } from '../util/exec.js';
import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Cron — scheduled task management
// ─────────────────────────────────────────────────────────────────────────────

export interface CronInput {
  action: 'add' | 'list' | 'remove' | 'remove_all' | 'run';
  schedule?: string;   // cron expression: "*/5 * * * *" or presets: "every_minute", "every_hour", "daily", "weekly", "hourly"
  command?: string;    // shell command to run
  label?: string;      // comment label to identify the job
  id?: string;         // job label for remove
}

export const CRON_DEFINITION: ToolDefinition = {
  name: 'cron',
  description:
    'Manage scheduled tasks (cron jobs). Add, list, remove scheduled commands. ' +
    'Schedule presets: every_minute, every_5_minutes, every_15_minutes, hourly, daily_8am, daily_9pm, weekly, midnight. ' +
    'Or use standard cron expressions (e.g., "*/10 * * * *" = every 10 min). ' +
    'Useful for: periodic checks, reminders, backups, monitoring, auto-sync.',
  parameters: {
    type: 'object',
    properties: {
      action:   { type: 'string', description: 'Action: add, list, remove, remove_all, run' },
      schedule: { type: 'string', description: 'Cron schedule (expression or preset name)' },
      command:  { type: 'string', description: 'Shell command to execute (for add)' },
      label:    { type: 'string', description: 'Label to identify the job (for add)' },
      id:       { type: 'string', description: 'Job label to remove (for remove)' },
    },
    required: ['action'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Schedule presets
// ─────────────────────────────────────────────────────────────────────────────

const PRESETS: Record<string, string> = {
  'every_minute':        '* * * * *',
  'every_5_minutes':     '*/5 * * * *',
  'every_15_minutes':    '*/15 * * * *',
  'every_30_minutes':    '*/30 * * * *',
  'hourly':              '0 * * * *',
  'every_hour':          '0 * * * *',
  'daily':               '0 9 * * *',
  'daily_8am':           '0 8 * * *',
  'daily_9am':           '0 9 * * *',
  'daily_9pm':           '21 * * * *',
  'midnight':            '0 0 * * *',
  'weekly':              '0 9 * * 1',
  'weekly_monday':       '0 9 * * 1',
  'monthly':             '0 9 1 * *',
};

function resolveSchedule(input: string): string {
  const lower = input.toLowerCase().trim();
  if (PRESETS[lower]) return PRESETS[lower];
  // Validate cron expression (5 fields)
  const parts = input.trim().split(/\s+/);
  if (parts.length === 5 && parts.every(p => /^[0-9A-Za-z*\/,-]+$/.test(p))) return parts.join(' ');
  throw new Error(`Invalid schedule: "${input}". Use a preset (${Object.keys(PRESETS).join(', ')}) or a 5-field cron expression.`);
}

const TAG = '# aura:';
function tagFor(label: string): string {
  return `${TAG} ${label}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Crontab operations
// ─────────────────────────────────────────────────────────────────────────────

function getCrontab(): string {
  // exit 1 = "no crontab for user": an empty table, not an error
  const r = run('crontab', ['-l'], { timeoutMs: 10_000 });
  return r.status === 0 ? r.stdout : '';
}

function setCrontab(content: string): void {
  // The table goes on stdin. It used to be `echo "<content>" | crontab -`,
  // and inside double quotes the shell still runs $(…) and `…` — so a job
  // containing either executed right there, while being saved.
  const r = run('crontab', ['-'], { input: content, timeoutMs: 10_000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`crontab failed: ${r.stderr.trim() || `exit ${r.status}`}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

function doAdd(input: CronInput): string {
  if (!input.command) return 'Error: command is required for add';
  if (!input.schedule) return 'Error: schedule is required for add';

  const schedule = resolveSchedule(input.schedule);
  const label = input.label ?? `job-${Date.now().toString(36)}`;
  // One job = one crontab line. A line break would add lines of its own.
  if (/[\r\n]/.test(input.command)) return 'Error: command must be a single line';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(label)) return 'Error: label may only use letters, digits, . _ - (max 64)';

  const existing = getCrontab();
  const lines = existing.split('\n').filter(l => l.trim());

  // Remove existing job with same label
  const filtered = lines.filter(l => !l.includes(tagFor(label)));

  // Add new job
  filtered.push(`${schedule} ${input.command}  ${tagFor(label)}`);

  setCrontab(filtered.join('\n') + '\n');
  return `Cron job added: "${label}"\nSchedule: ${schedule}\nCommand: ${input.command}`;
}

function doList(): string {
  const content = getCrontab();
  if (!content.trim()) return 'No cron jobs configured.';

  const lines = content.split('\n').filter(l => l.trim());
  const auraJobs = lines.filter(l => l.includes(TAG));
  const otherJobs = lines.filter(l => !l.includes(TAG) && l.trim());

  const parts: string[] = [];

  if (auraJobs.length > 0) {
    parts.push(`Aura jobs (${auraJobs.length}):`);
    auraJobs.forEach((l, i) => {
      const labelMatch = l.match(/# aura: (.+)/);
      const label = labelMatch ? labelMatch[1] : 'unnamed';
      const schedule = l.split(/\s+/).slice(0, 5).join(' ');
      const cmd = l.replace(/\s*# aura:.*/, '').replace(/^(\S+\s+){5}/, '').trim();
      parts.push(`  ${i + 1}. [${label}] ${schedule} → ${cmd}`);
    });
  }

  if (otherJobs.length > 0) {
    parts.push(`\nSystem jobs (${otherJobs.length}):`);
    otherJobs.forEach(l => parts.push(`  ${l}`));
  }

  return parts.join('\n');
}

function doRemove(id: string): string {
  const existing = getCrontab();
  const lines = existing.split('\n');
  const filtered = lines.filter(l => !l.includes(tagFor(id)));

  if (filtered.length === lines.length) {
    return `Error: No cron job found with label "${id}"`;
  }

  setCrontab(filtered.join('\n') + '\n');
  return `Cron job removed: "${id}"`;
}

function doRemoveAll(): string {
  const existing = getCrontab();
  const lines = existing.split('\n');
  const filtered = lines.filter(l => !l.includes(TAG));

  const removed = lines.length - filtered.length;
  if (removed === 0) return 'No Aura cron jobs to remove.';

  setCrontab(filtered.join('\n') + '\n');
  return `Removed ${removed} Aura cron job(s).`;
}

function doRun(input: CronInput): string {
  if (!input.command) return 'Error: command is required for run';
  try {
    // A shell on purpose (this action runs a shell command), with the same
    // permission screen as run_shell — see shellCommandOf in safety/permissions.
    const r = run('sh', ['-c', input.command], { env: process.env, timeoutMs: 30_000 });
    if (r.error || r.status !== 0) return `Command error:\n${r.stderr || r.error?.message || `exit ${r.status}`}`;
    return `Command output:\n${r.stdout}`;
  } catch (e: any) {
    return `Command error:\n${e?.message ?? String(e)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main executor
// ─────────────────────────────────────────────────────────────────────────────

export async function cronTool(input: CronInput): Promise<string> {
  try {
    switch (input.action) {
      case 'add':        return doAdd(input);
      case 'list':       return doList();
      case 'remove': {
        if (!input.id) return 'Error: id (label) is required for remove';
        return doRemove(input.id);
      }
      case 'remove_all': return doRemoveAll();
      case 'run':        return doRun(input);
      default:           return `Error: Unknown cron action: ${input.action}`;
    }
  } catch (e: any) {
    return `Cron error: ${e?.message ?? String(e)}`;
  }
}
