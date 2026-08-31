import { describe, it, expect } from 'vitest';
import { agentPrompt, mergeSwarmOutcomes, type SwarmAgentOutcome } from '../../src/agent/swarm.js';
import type { BoardTask } from '../../src/board/types.js';

/**
 * The swarm's prompt shaping and outcome merging are pure functions, and both
 * carry real decisions: what an agent is told it is, and whether partial
 * success counts. Both are pinned here.
 */
describe('swarm', () => {
  const baseTask = {
    id: 't1',
    title: 'Optimize the token pipeline',
    notes: 'Survey hotspots and cut cost without breaking tests.',
    column: 'execution',
    order: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as BoardTask;

  it('role-scopes the prompt for a named agent', () => {
    const p = agentPrompt(
      { id: 'a1', name: 'Researcher', role: 'Surveys token cost hotspots', icon: '🔍' },
      baseTask,
    );
    expect(p).toContain('Your role in the swarm: Surveys token cost hotspots');
    expect(p).toContain(baseTask.title);
  });

  it('passes the plain task prompt for an agent with no role', () => {
    const p = agentPrompt({ id: 'a2', name: 'Worker' }, baseTask);
    expect(p).toContain(baseTask.title);
    expect(p).not.toContain('Your role in the swarm');
  });

  it('merges outcomes: partial success counts, failures stay named', () => {
    const mk = (name: string, success: boolean, summary = ''): SwarmAgentOutcome => ({
      agent: { id: name.toLowerCase(), name, icon: '•' },
      success,
      summary,
      files: [],
    });

    const merged = mergeSwarmOutcomes([
      mk('Architect', true, 'Designed the AST transform.'),
      mk('Coder', true, 'Cut 40% of tokens in the hot path.'),
      mk('QA', false, 'Suite failed after the change.'),
    ]);

    expect(merged.success).toBe(true);
    expect(merged.summary).toContain('2/3 agents completed');
    expect(merged.summary).toContain('QA ✗');
    expect(merged.summary).toContain('Suite failed after the change.');
  });
});
