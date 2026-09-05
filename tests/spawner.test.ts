import { describe, it, expect, afterEach } from 'vitest';
import { registerSpawner, clearSpawner, executeSpawnTask, makeDefaultSpawner, resolveSubagentModel } from '../src/agent/spawner.js';
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

describe('resolveSubagentModel', () => {
  const env = {};

  it('an explicit pick from the spawning model wins', () => {
    expect(resolveSubagentModel('gpt-4o-mini', env, 'session-model')).toBe('gpt-4o-mini');
  });

  it('AURA_SUBAGENT_MODEL beats the session model', () => {
    expect(resolveSubagentModel(undefined, { AURA_SUBAGENT_MODEL: 'z-ai/glm-5.3-flash' }, 'session-model'))
      .toBe('z-ai/glm-5.3-flash');
  });

  it('falls back to the session model', () => {
    expect(resolveSubagentModel(undefined, env, 'z-ai/glm-5.3-flash')).toBe('z-ai/glm-5.3-flash');
  });

  it('whitespace-padded values are trimmed', () => {
    expect(resolveSubagentModel('  ', { AURA_SUBAGENT_MODEL: ' x ' }, undefined)).toBe('x');
  });

  it('returns undefined when nothing is set — spawn reports it instead of guessing', () => {
    expect(resolveSubagentModel(undefined, env, undefined)).toBeUndefined();
  });
});
