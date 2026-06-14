import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cronTool, CRON_DEFINITION } from '../src/tools/cron.js';

// Mock child_process
let mockCrontab = '';
vi.mock('child_process', () => ({
  execSync: vi.fn().mockImplementation((cmd: string, opts?: any) => {
    if (cmd === 'crontab -l 2>/dev/null') {
      if (!mockCrontab) throw new Error('no crontab');
      return mockCrontab;
    }
    if (cmd.startsWith('echo') && cmd.includes('crontab')) {
      // Extract content piped to crontab
      const match = cmd.match(/^echo\s+"(.+?)"\s*\|\s*crontab\s*-$/s);
      if (match) mockCrontab = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      return '';
    }
    if (opts?.encoding) return 'command output';
    return Buffer.from('');
  }),
}));

beforeEach(() => {
  mockCrontab = '';
});

describe('CRON_DEFINITION', () => {
  it('has correct name', () => expect(CRON_DEFINITION.name).toBe('cron'));
  it('requires action', () => expect(CRON_DEFINITION.parameters.required).toEqual(['action']));
});

describe('cronTool — list', () => {
  it('returns empty message when no crontab', async () => {
    const r = await cronTool({ action: 'list' });
    expect(r).toContain('No cron jobs');
  });

  it('lists aura jobs', async () => {
    mockCrontab = '0 9 * * * echo hello  # aura: morning-greeting\n';
    const r = await cronTool({ action: 'list' });
    expect(r).toContain('morning-greeting');
    expect(r).toContain('0 9 * * *');
  });
});

describe('cronTool — add', () => {
  it('requires command', async () => {
    const r = await cronTool({ action: 'add', schedule: 'daily' });
    expect(r).toContain('Error: command');
  });

  it('requires schedule', async () => {
    const r = await cronTool({ action: 'add', command: 'echo test' });
    expect(r).toContain('Error: schedule');
  });

  it('adds a job with preset schedule', async () => {
    const r = await cronTool({ action: 'add', schedule: 'hourly', command: 'echo test', label: 'test-job' });
    expect(r).toContain('Cron job added');
    expect(r).toContain('test-job');
    expect(r).toContain('0 * * * *');
  });

  it('adds a job with custom cron expression', async () => {
    const r = await cronTool({ action: 'add', schedule: '*/10 * * * *', command: 'echo test', label: 'ten-min' });
    expect(r).toContain('Cron job added');
    expect(r).toContain('*/10 * * * *');
  });

  it('rejects invalid schedule', async () => {
    const r = await cronTool({ action: 'add', schedule: 'invalid', command: 'echo test' });
    expect(r).toContain('Invalid schedule');
  });

  it('replaces existing job with same label', async () => {
    await cronTool({ action: 'add', schedule: 'hourly', command: 'echo old', label: 'dup' });
    await cronTool({ action: 'add', schedule: 'daily', command: 'echo new', label: 'dup' });
    expect(mockCrontab).toContain('echo new');
    expect(mockCrontab).not.toContain('echo old');
  });
});

describe('cronTool — remove', () => {
  it('removes a job by label', async () => {
    await cronTool({ action: 'add', schedule: 'daily', command: 'echo bye', label: 'remove-me' });
    const r = await cronTool({ action: 'remove', id: 'remove-me' });
    expect(r).toContain('removed');
  });

  it('returns error for unknown label', async () => {
    const r = await cronTool({ action: 'remove', id: 'nonexistent' });
    expect(r).toContain('Error: No cron job found');
  });

  it('requires id', async () => {
    const r = await cronTool({ action: 'remove' });
    expect(r).toContain('Error: id');
  });
});

describe('cronTool — remove_all', () => {
  it('removes all aura jobs', async () => {
    await cronTool({ action: 'add', schedule: 'daily', command: 'echo a', label: 'job1' });
    await cronTool({ action: 'add', schedule: 'daily', command: 'echo b', label: 'job2' });
    const r = await cronTool({ action: 'remove_all' });
    expect(r).toContain('Removed 2');
  });

  it('returns message when nothing to remove', async () => {
    const r = await cronTool({ action: 'remove_all' });
    expect(r).toContain('No Aura cron jobs');
  });
});

describe('cronTool — presets', () => {
  it.each([
    ['every_minute', '* * * * *'],
    ['every_5_minutes', '*/5 * * * *'],
    ['hourly', '0 * * * *'],
    ['daily', '0 9 * * *'],
    ['midnight', '0 0 * * *'],
    ['weekly', '0 9 * * 1'],
  ])('preset "%s" resolves to "%s"', async (preset, expected) => {
    const r = await cronTool({ action: 'add', schedule: preset, command: 'echo test', label: preset });
    expect(r).toContain(expected);
  });
});
