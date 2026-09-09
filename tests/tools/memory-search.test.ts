import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// AURA_HOME must be set before the module resolves its memory dir.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-mem-'));
process.env.AURA_HOME = home;
fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
fs.writeFileSync(
  path.join(home, 'memory', 'topics.json'),
  JSON.stringify({
    'linear-algebra': { value: 'An eigenvector of A satisfies Av = lambda v.', updated: '2026-01-01' },
    'chemistry-moles': { value: 'One mole is 6.022e23 particles.', updated: '2026-01-02' },
  }),
);

const { memoryTool } = await import('../../src/tools/memory.js');

describe('memory: search', () => {
  it('matches on a body term and excludes unrelated entries', async () => {
    const r = await memoryTool({ action: 'search', query: 'eigenvector' });
    expect(r).toContain('topics/linear-algebra');
    expect(r).not.toContain('chemistry-moles');
  });

  it('matches on a key term across namespaces', async () => {
    const r = await memoryTool({ action: 'search', query: 'chemistry' });
    expect(r).toContain('chemistry-moles');
  });

  it('requires a query', async () => {
    expect(await memoryTool({ action: 'search' })).toContain('query is required');
  });

  it('reports a clean miss rather than dumping the store', async () => {
    const r = await memoryTool({ action: 'search', query: 'zzzznothing' });
    expect(r).toContain('No memories match');
  });
});
