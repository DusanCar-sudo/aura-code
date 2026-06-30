import { describe, it, expect, afterEach } from 'vitest';
import { registerSpawner, clearSpawner, executeSpawnTask, makeDefaultSpawner } from '../src/agent/spawner.js';
import type { Spawner } from '../src/agent/spawner.js';

describe('executeSpawnTask', () => {
  afterEach(() => clearSpawner());

  it('returns error when no spawner is registered', async () => {
    const result = await executeSpawnTask({ task: 'do something' });
    expect(result).toMatch(/not available/);
  });

  it('returns error for empty task', async () => {
    const fake: Spawner = { spawn: async () => 'should not be called' };
    registerSpawner(fake);
    const result = await executeSpawnTask({ task: '  ' });
    expect(result).toMatch(/non-empty/);
  });

  it('dispatches to registered spawner with parsed options', async () => {
    let received: { task: string; model?: string; readonly?: boolean } | null = null;
    const fake: Spawner = { spawn: async (opts) => { received = opts; return 'subagent result'; } };
    registerSpawner(fake);
    const result = await executeSpawnTask({ task: 'explain X', model: 'gpt-4o-mini', readonly: true });
    expect(result).toBe('subagent result');
    expect(received).toEqual({ task: 'explain X', model: 'gpt-4o-mini', readonly: true, cwd: undefined });
  });

  it('makeDefaultSpawner is a function (not undefined)', () => {
    expect(typeof makeDefaultSpawner).toBe('function');
  });
});
