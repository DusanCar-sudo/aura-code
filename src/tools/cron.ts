import { execSync } from 'child_process';
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
  if (parts.length === 5) return input;
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
  try {
    return execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function setCrontab(content: string): void {
  execSync(`echo ${JSON.stringify(content)} | crontab -`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

function doAdd(input: CronInput): string {
  if (!input.command) return 'Error: command is required for add';
  if (!input.schedule) return 'Error: schedule is required for add';

  const schedule = resolveSchedule(input.schedule);
  const label = input.label ?? `job-${Date.now().toString(36)}`;

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
    const output = execSync(input.command, { encoding: 'utf8', timeout: 30_000 });
    return `Command output:\n${output}`;
  } catch (e: any) {
    return `Command error:\n${e?.stderr ?? e?.message ?? String(e)}`;
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
