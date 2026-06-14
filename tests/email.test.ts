import { describe, it, expect, vi } from 'vitest';
import { emailTool, EMAIL_DEFINITION } from '../src/tools/email.js';

vi.mock('child_process', () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    if (cmd.startsWith('which')) throw new Error('not found');
    return '';
  }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: () => false };
});

describe('EMAIL_DEFINITION', () => {
  it('has correct name', () => expect(EMAIL_DEFINITION.name).toBe('email'));
  it('requires action', () => expect(EMAIL_DEFINITION.parameters.required).toEqual(['action']));
});

describe('emailTool — send', () => {
  it('requires to field', async () => {
    const r = await emailTool({ action: 'send', subject: 'test', body: 'hello' });
    expect(r).toContain('Error: to');
  });

  it('requires subject field', async () => {
    const r = await emailTool({ action: 'send', to: 'test@test.com', body: 'hello' });
    expect(r).toContain('Error: subject');
  });

  it('requires body field', async () => {
    const r = await emailTool({ action: 'send', to: 'test@test.com', subject: 'test' });
    expect(r).toContain('Error: body');
  });

  it('returns error when no mail command found', async () => {
    const r = await emailTool({ action: 'send', to: 'test@test.com', subject: 'test', body: 'hello' });
    expect(r).toContain('Error');
  });
});

describe('emailTool — read', () => {
  it('returns error when no mailbox found', async () => {
    const r = await emailTool({ action: 'read' });
    expect(r).toContain('No local mailbox found');
  });
});
