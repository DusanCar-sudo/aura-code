import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clipboardTool, CLIPBOARD_DEFINITION } from '../src/tools/clipboard.js';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    if (cmd.startsWith('which')) return '/usr/bin/xclip';
    if (cmd.includes('xclip') && cmd.includes('-o')) return 'clipboard content';
    return '';
  }),
}));

describe('CLIPBOARD_DEFINITION', () => {
  it('has correct name', () => expect(CLIPBOARD_DEFINITION.name).toBe('clipboard'));
  it('requires action', () => expect(CLIPBOARD_DEFINITION.parameters.required).toEqual(['action']));
});

describe('clipboardTool — copy', () => {
  it('copies text to clipboard', async () => {
    const r = await clipboardTool({ action: 'copy', text: 'hello world' });
    expect(r).toContain('Copied');
    expect(r).toContain('11 characters');
  });

  it('returns error for missing text', async () => {
    const r = await clipboardTool({ action: 'copy' });
    expect(r).toContain('Error: text');
  });
});

describe('clipboardTool — paste', () => {
  it('reads clipboard content', async () => {
    const r = await clipboardTool({ action: 'paste' });
    expect(r).toContain('Clipboard contents');
    expect(r).toContain('clipboard content');
  });
});
