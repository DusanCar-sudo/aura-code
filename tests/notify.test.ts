import { describe, it, expect, vi } from 'vitest';
import { notifyTool, NOTIFY_DEFINITION } from '../src/tools/notify.js';

vi.mock('child_process', () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    if (cmd.startsWith('which')) throw new Error('not found'); // simulate headless
    return '';
  }),
}));

describe('NOTIFY_DEFINITION', () => {
  it('has correct name', () => expect(NOTIFY_DEFINITION.name).toBe('notify'));
  it('requires title and message', () => expect(NOTIFY_DEFINITION.parameters.required).toEqual(['title', 'message']));
});

describe('notifyTool', () => {
  it('returns fallback message when no notify-send', async () => {
    const r = await notifyTool({ title: 'Test', message: 'Hello' });
    expect(r).toContain('[Notification]');
    expect(r).toContain('Test');
    expect(r).toContain('Hello');
  });
});
