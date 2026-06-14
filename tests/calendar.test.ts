import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { calendarTool, CALENDAR_DEFINITION } from '../src/tools/calendar.js';

const testDir = path.join(os.tmpdir(), 'ruby-test-calendar-' + Date.now());

beforeEach(() => {
  process.env.HOME = testDir;
  fs.mkdirSync(path.join(testDir, '.aura'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('CALENDAR_DEFINITION', () => {
  it('has correct name', () => expect(CALENDAR_DEFINITION.name).toBe('calendar'));
  it('requires action', () => expect(CALENDAR_DEFINITION.parameters.required).toEqual(['action']));
});

describe('calendarTool — add', () => {
  it('adds an event', async () => {
    const r = await calendarTool({ action: 'add', title: 'Meeting', date: '2026-06-20' });
    expect(r).toContain('Event added');
    expect(r).toContain('Meeting');
    expect(r).toContain('2026-06-20');
  });

  it('adds event with relative date', async () => {
    const r = await calendarTool({ action: 'add', title: 'Call', date: 'tomorrow' });
    expect(r).toContain('Event added');
  });

  it('requires title', async () => {
    const r = await calendarTool({ action: 'add', date: '2026-06-20' });
    expect(r).toContain('Error: title');
  });

  it('requires date', async () => {
    const r = await calendarTool({ action: 'add', title: 'Test' });
    expect(r).toContain('Error: date');
  });
});

describe('calendarTool — list', () => {
  it('returns empty when no events', async () => {
    const r = await calendarTool({ action: 'list' });
    expect(r).toContain('No events');
  });

  it('lists added events', async () => {
    await calendarTool({ action: 'add', title: 'Event A', date: '2026-06-20' });
    await calendarTool({ action: 'add', title: 'Event B', date: '2026-06-21' });
    const r = await calendarTool({ action: 'list' });
    expect(r).toContain('Event A');
    expect(r).toContain('Event B');
    expect(r).toContain('2 events');
  });
});

describe('calendarTool — today', () => {
  it('returns no events when none today', async () => {
    const r = await calendarTool({ action: 'today' });
    expect(r).toContain('No events today');
  });
});

describe('calendarTool — upcoming', () => {
  it('returns no events when none upcoming', async () => {
    const r = await calendarTool({ action: 'upcoming', days_ahead: 1 });
    expect(r).toContain('No events');
  });

  it('finds upcoming events', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];
    await calendarTool({ action: 'add', title: 'Soon', date: dateStr });
    const r = await calendarTool({ action: 'upcoming', days_ahead: 7 });
    expect(r).toContain('Soon');
  });
});

describe('calendarTool — delete', () => {
  it('deletes an event by id', async () => {
    const addResult = await calendarTool({ action: 'add', title: 'Temp', date: '2026-06-20' });
    const idMatch = addResult.match(/ID: (\S+)/);
    const id = idMatch![1];
    const r = await calendarTool({ action: 'delete', id });
    expect(r).toContain('Deleted');
  });

  it('returns error for unknown id', async () => {
    const r = await calendarTool({ action: 'delete', id: 'nonexistent' });
    expect(r).toContain('Error: Event not found');
  });
});

describe('calendarTool — remind', () => {
  it('sets a reminder', async () => {
    const r = await calendarTool({ action: 'remind', title: 'Buy milk' });
    expect(r).toContain('Reminder set');
    expect(r).toContain('Buy milk');
  });
});
