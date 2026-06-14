import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Calendar — simple calendar/reminder system
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarInput {
  action: 'add' | 'list' | 'today' | 'upcoming' | 'delete' | 'remind';
  title?: string;
  date?: string;       // ISO date or "tomorrow", "next monday"
  time?: string;       // HH:MM format
  description?: string;
  id?: string;
  days_ahead?: number;
}

export const CALENDAR_DEFINITION: ToolDefinition = {
  name: 'calendar',
  description:
    'Calendar and reminder system. Add events, list upcoming events, get today\'s schedule, delete events. ' +
    'Dates can be ISO format (2026-06-15) or relative (tomorrow, next monday).',
  parameters: {
    type: 'object',
    properties: {
      action:       { type: 'string', description: 'Action: add, list, today, upcoming, delete, remind' },
      title:        { type: 'string', description: 'Event title (for add/remind)' },
      date:         { type: 'string', description: 'Event date: ISO (2026-06-15) or relative (tomorrow, next monday)' },
      time:         { type: 'string', description: 'Event time in HH:MM format' },
      description:  { type: 'string', description: 'Event description' },
      id:           { type: 'string', description: 'Event ID (for delete)' },
      days_ahead:   { type: 'number', description: 'Days to look ahead for upcoming (default: 7)' },
    },
    required: ['action'],
  },
};

interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  time?: string;
  description?: string;
  created: string;
}

function calendarPath(): string {
  const dir = path.join(os.homedir(), '.aura');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'calendar.json');
}

function loadEvents(): CalendarEvent[] {
  const p = calendarPath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function saveEvents(events: CalendarEvent[]): void {
  fs.writeFileSync(calendarPath(), JSON.stringify(events, null, 2), 'utf8');
}

function parseRelativeDate(input: string): Date {
  const lower = input.toLowerCase().trim();
  const now = new Date();

  if (lower === 'today') return now;
  if (lower === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const match = lower.match(/^next\s+(\w+)$/);
  if (match) {
    const targetDay = days.indexOf(match[1]);
    if (targetDay !== -1) {
      const d = new Date(now);
      const current = d.getDay();
      let diff = targetDay - current;
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  // Try ISO parse
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) return parsed;

  return now; // fallback
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

export async function calendarTool(input: CalendarInput): Promise<string> {
  switch (input.action) {
    case 'add': {
      if (!input.title) return 'Error: title is required for add';
      if (!input.date) return 'Error: date is required for add';

      const date = parseRelativeDate(input.date);
      const event: CalendarEvent = {
        id: generateId(),
        title: input.title,
        date: formatDate(date),
        time: input.time,
        description: input.description,
        created: new Date().toISOString(),
      };

      const events = loadEvents();
      events.push(event);
      events.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
      saveEvents(events);

      return `Event added: "${event.title}" on ${event.date}${event.time ? ' at ' + event.time : ''}\nID: ${event.id}`;
    }

    case 'list': {
      const events = loadEvents();
      if (events.length === 0) return 'No events in calendar.';
      const lines = events.map(e =>
        `[${e.id}] ${e.date}${e.time ? ' ' + e.time : ''} — ${e.title}${e.description ? '\n  ' + e.description : ''}`
      );
      return `Calendar (${events.length} events):\n${lines.join('\n')}`;
    }

    case 'today': {
      const today = formatDate(new Date());
      const events = loadEvents().filter(e => e.date === today);
      if (events.length === 0) return `No events today (${today}).`;
      const lines = events.map(e =>
        `${e.time ?? 'all day'} — ${e.title}${e.description ? '\n  ' + e.description : ''}`
      );
      return `Today (${today}):\n${lines.join('\n')}`;
    }

    case 'upcoming': {
      const days = input.days_ahead ?? 7;
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + days);
      const todayStr = formatDate(now);
      const endStr = formatDate(end);

      const events = loadEvents().filter(e => e.date >= todayStr && e.date <= endStr);
      if (events.length === 0) return `No events in the next ${days} days.`;
      const lines = events.map(e =>
        `[${e.id}] ${e.date}${e.time ? ' ' + e.time : ''} — ${e.title}`
      );
      return `Upcoming (${days} days, ${events.length} events):\n${lines.join('\n')}`;
    }

    case 'delete': {
      if (!input.id) return 'Error: id is required for delete';
      const events = loadEvents();
      const idx = events.findIndex(e => e.id === input.id);
      if (idx === -1) return `Error: Event not found: ${input.id}`;
      const removed = events.splice(idx, 1)[0];
      saveEvents(events);
      return `Deleted: "${removed.title}" on ${removed.date}`;
    }

    case 'remind': {
      if (!input.title) return 'Error: title is required for remind';
      const events = loadEvents();
      const event: CalendarEvent = {
        id: generateId(),
        title: `⏰ REMINDER: ${input.title}`,
        date: input.date ? formatDate(parseRelativeDate(input.date)) : formatDate(new Date()),
        time: input.time,
        description: input.description,
        created: new Date().toISOString(),
      };
      events.push(event);
      saveEvents(events);
      return `Reminder set: "${input.title}" on ${event.date}${event.time ? ' at ' + event.time : ''}`;
    }

    default:
      return `Error: Unknown calendar action: ${input.action}`;
  }
}
