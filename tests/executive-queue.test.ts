import { describe, it, expect } from 'vitest';
import { ExecutiveQueue, EXECUTIVE_QUEUE_MAX, MUTATING_TOOLS } from '../src/agent/executive-queue.js';

describe('ExecutiveQueue', () => {
  it('records only state-altering tools', () => {
    const q = new ExecutiveQueue();
    q.push('read_file', { path: 'a.ts' }, 1);
    q.push('list_files', { path: '.' }, 1);
    q.push('write_file', { path: 'src/a.ts' }, 2);
    q.push('edit_file', { path: 'src/b.ts' }, 3);
    q.push('run_shell', { command: 'npm test' }, 4);
    expect(q.size).toBe(3);
  });

  it('caps at EXECUTIVE_QUEUE_MAX with FIFO eviction', () => {
    const q = new ExecutiveQueue();
    for (let i = 0; i < EXECUTIVE_QUEUE_MAX + 5; i++) {
      q.push('write_file', { path: `f${i}.ts` }, i);
    }
    expect(q.size).toBe(EXECUTIVE_QUEUE_MAX);
    const digest = q.digest();
    expect(digest).not.toContain('f0.ts');       // oldest evicted
    expect(digest).not.toContain('f4.ts');
    expect(digest).toContain('f5.ts');            // oldest survivor
    expect(digest).toContain(`f${EXECUTIVE_QUEUE_MAX + 4}.ts`); // newest
  });

  it('formats the digest with a header and truncated commands', () => {
    const q = new ExecutiveQueue();
    q.push('run_shell', { command: 'x'.repeat(150) }, 1);
    q.push('write_file', { path: 'src/x.ts' }, 2);
    const digest = q.digest();
    expect(digest).toMatch(/^Recent state-altering actions already executed/);
    expect(digest).toContain('run_shell: ' + 'x'.repeat(100) + '…');
    expect(digest).toContain('write_file src/x.ts');
  });

  it('returns empty digest when empty', () => {
    expect(new ExecutiveQueue().digest()).toBe('');
  });

  it('exports the mutating tool set the loop uses for checkpoints', () => {
    expect([...MUTATING_TOOLS].sort()).toEqual(['edit_file', 'run_shell', 'write_file']);
  });
});
