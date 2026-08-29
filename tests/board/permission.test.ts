import { describe, it, expect } from 'vitest';
import { AGENT_PRESETS, effectivePermission } from '../../src/board/agents.js';

/**
 * A board task runs under two opinions about permission: the agent's preset,
 * and whatever the operator chose in Settings. The preset is the ceiling and
 * the operator's choice applies beneath it.
 *
 * Getting this backwards is dangerous in one direction and merely annoying in
 * the other, so both are pinned: a reviewer must never become writable, and
 * "auto" must actually stop the prompting for the agents that allow it.
 */

describe('the permission a task runs under', () => {
  it('honours auto for the agents whose preset allows it', () => {
    // The bug this fixes: someone set auto in Settings and was still asked to
    // approve every shell command, because nothing consulted them.
    expect(effectivePermission(AGENT_PRESETS.aura, 'auto')).toBe('auto');
    expect(effectivePermission(AGENT_PRESETS.coder, 'auto')).toBe('auto');
  });

  it('never lets a read-only agent be raised', () => {
    // The whole promise of the preset. A reviewer that could be talked into
    // `auto` is not read-only, it is read-only-by-default, which is a
    // different and much weaker claim.
    expect(effectivePermission(AGENT_PRESETS.reviewer, 'auto')).toBe('read-only');
    expect(effectivePermission(AGENT_PRESETS.researcher, 'auto')).toBe('read-only');
    expect(effectivePermission(AGENT_PRESETS.planner, 'normal')).toBe('read-only');
  });

  it('lets the operator be stricter than the preset', () => {
    expect(effectivePermission(AGENT_PRESETS.coder, 'read-only')).toBe('read-only');
    expect(effectivePermission(AGENT_PRESETS.aura, 'normal')).toBe('normal');
  });

  it('falls back to the preset when nothing was chosen', () => {
    expect(effectivePermission(AGENT_PRESETS.aura, undefined)).toBe('normal');
    expect(effectivePermission(AGENT_PRESETS.reviewer, undefined)).toBe('read-only');
  });
});
