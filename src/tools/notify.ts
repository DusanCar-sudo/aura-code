import { execSync } from 'child_process';
import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Notify — desktop notifications
// ─────────────────────────────────────────────────────────────────────────────

export interface NotifyInput {
  title: string;
  message: string;
  urgency?: 'low' | 'normal' | 'critical';
  sound?: boolean;
}

export const NOTIFY_DEFINITION: ToolDefinition = {
  name: 'notify',
  description:
    'Send a desktop notification to the user. Use for alerts, task completion, ' +
    'reminders, or anything that needs the user\'s attention.',
  parameters: {
    type: 'object',
    properties: {
      title:    { type: 'string', description: 'Notification title' },
      message:  { type: 'string', description: 'Notification body text' },
      urgency:  { type: 'string', description: 'Urgency level: low, normal, critical (default: normal)' },
      sound:    { type: 'boolean', description: 'Play a sound (default: false)' },
    },
    required: ['title', 'message'],
  },
};

export async function notifyTool(input: NotifyInput): Promise<string> {
  const urgency = input.urgency ?? 'normal';

  // Try notify-send (Linux — most desktop environments)
  try {
    execSync('which notify-send', { stdio: 'pipe' });
    const args = [
      'notify-send',
      `--urgency=${urgency}`,
      `--app-name=Aura`,
      JSON.stringify(input.title),
      JSON.stringify(input.message),
    ];
    execSync(args.join(' '), { stdio: 'pipe' });
    return `Notification sent: "${input.title}" — ${input.message}`;
  } catch { /* not found */ }

  // Fallback: print to terminal (for headless / SSH)
  return `[Notification] ${input.title}: ${input.message}`;
}
