import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BoardTask, SwarmAgent } from '../../src/board/types.js';

/**
 * `runSwarm` used to fire the whole roster at once and await `Promise.allSettled`,
 * so one throttled or hung provider stream held the tile in `running` forever.
 * These pin the two guards that stop that: a `maxParallel` cap on how many
 * agents run at once, and a per-agent timeout that turns a hung stream into a
 * failed outcome instead of a stalled swarm.
 */

function taskWith(agents: SwarmAgent[]): BoardTask {
  return {
    id: 't1',
    title: 'Find remote English teaching jobs',
    notes: 'parallel swarm',
    column: 'execution',
    order: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    swarm: { agents },
  } as unknown as BoardTask;
}

const agents = (n: number): SwarmAgent[] =>
  Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `Agent${i}`, role: 'works', icon: '•' }));

const okResult = { success: true, summary: 'done', turns: 1, toolCallCount: 0, toolCallLog: [] };

const stubProvider = () => ({
  name: 'stub', model: 'stub', supportsTools: true,
  complete: async () => ({ text: '', toolCalls: [], stopReason: 'done' as const }),
  async *stream() { /* empty */ },
});

describe('runSwarm concurrency + timeout', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../src/providers/factory.js', () => ({ createProvider: stubProvider }));
  });

  it('caps concurrent agents at maxParallel', async () => {
    let active = 0;
    let peak = 0;
    vi.doMock('../../src/agent/loop.js', () => ({
      runAgentLoop: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return okResult;
      },
    }));
    const { runSwarm } = await import('../../src/agent/swarm.js');

    const outcomes = await runSwarm({
      task: taskWith(agents(5)),
      context: {} as any,
      model: 'stub',
      permission: 'normal',
      onAgentUpdate: () => {},
      maxParallel: 2,
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((o) => o.success)).toBe(true);
  });

  it('aborts a hung agent at agentTimeoutMs instead of stalling the swarm', async () => {
    vi.doMock('../../src/agent/loop.js', () => ({
      runAgentLoop: async (o: any) => {
        if (String(o.task).includes('Hanger')) return new Promise(() => {}); // never settles
        return okResult;
      },
    }));
    const { runSwarm } = await import('../../src/agent/swarm.js');

    const started = Date.now();
    const outcomes = await runSwarm({
      task: taskWith([
        { id: 'h', name: 'Hanger', role: 'hangs forever', icon: '•' },
        { id: 'q', name: 'Quick', role: 'returns fast', icon: '•' },
      ]),
      context: {} as any,
      model: 'stub',
      permission: 'normal',
      onAgentUpdate: () => {},
      agentTimeoutMs: 50,
    });

    expect(Date.now() - started).toBeLessThan(2000);
    const hanger = outcomes.find((o) => o.agent.name === 'Hanger')!;
    expect(hanger.success).toBe(false);
    expect(hanger.summary).toMatch(/timed out/i);

    const quick = outcomes.find((o) => o.agent.name === 'Quick')!;
    expect(quick.success).toBe(true);
  });

  it('reports outcomes in roster order regardless of who finished first', async () => {
    vi.doMock('../../src/agent/loop.js', () => ({
      runAgentLoop: async (o: any) => {
        // The first agent is slow, the rest are quick — completion order is
        // scrambled, but the returned array must still match the roster.
        const slow = String(o.task).includes('Agent0');
        await new Promise((r) => setTimeout(r, slow ? 20 : 1));
        return okResult;
      },
    }));
    const { runSwarm } = await import('../../src/agent/swarm.js');

    const roster = agents(3);
    const outcomes = await runSwarm({
      task: taskWith(roster),
      context: {} as any,
      model: 'stub',
      permission: 'normal',
      onAgentUpdate: () => {},
      maxParallel: 3,
    });

    expect(outcomes.map((o) => o.agent.id)).toEqual(roster.map((a) => a.id));
  });
});
