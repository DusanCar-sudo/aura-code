import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadProjectContext } from '../../src/agent/context.js';

/**
 * The gap this closes: AURA.md and AGENTS.md are two files with two jobs —
 * AURA.md says how to work in this repo, AGENTS.md says what the repo is — and
 * they are read into the prompt through separate fields with separate budgets.
 * Collapsing them (the obvious "simplification") reintroduces the exact problem
 * the split avoids: one truncation point, with the standing rules competing
 * against a project description five times their size and losing.
 *
 * These assert the fields stay independent, and that the old CLAUDE.md name
 * still resolves — a repo that has not been renamed must not silently lose its
 * project notes.
 */

let root: string;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-ctx-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const write = (name: string, body: string) => fs.writeFileSync(path.join(root, name), body);

describe('project docs are loaded into separate context fields', () => {
  it('reads AURA.md and AGENTS.md independently', async () => {
    write('AURA.md', '# Standing Rules\nThe default branch is master.');
    write('AGENTS.md', '# What this is\nA coding agent CLI.');
    const ctx = await loadProjectContext(root);
    expect(ctx.auraRules).toContain('default branch is master');
    expect(ctx.agentNotes).toContain('A coding agent CLI.');
    // Neither field may absorb the other — that is the whole point of two.
    expect(ctx.auraRules).not.toContain('A coding agent CLI.');
    expect(ctx.agentNotes).not.toContain('default branch is master');
  });

  it('falls back to CLAUDE.md when AGENTS.md is absent', async () => {
    write('CLAUDE.md', '# Legacy notes\nStill readable.');
    const ctx = await loadProjectContext(root);
    expect(ctx.agentNotes).toContain('Still readable.');
  });

  it('prefers AGENTS.md when both names exist', async () => {
    write('AGENTS.md', 'current');
    write('CLAUDE.md', 'stale');
    const ctx = await loadProjectContext(root);
    expect(ctx.agentNotes).toContain('current');
    expect(ctx.agentNotes).not.toContain('stale');
  });

  it('reports absence rather than throwing when neither exists', async () => {
    const ctx = await loadProjectContext(root);
    expect(ctx.agentNotes).toBe('(no AGENTS.md found)');
    expect(ctx.auraRules).toBe('(no AURA.md found)');
  });

  it('gives AGENTS.md its own, larger budget than AURA.md', async () => {
    // AURA.md is capped at 2000 and AGENTS.md at 4000. A shared cap is what
    // would push the standing rules out of the prompt.
    write('AURA.md', 'a'.repeat(5000));
    write('AGENTS.md', 'b'.repeat(6000));
    const ctx = await loadProjectContext(root);
    expect(ctx.auraRules).toContain('[...truncated]');
    expect(ctx.auraRules.replace(/\n\n\[\.\.\.truncated\]$/, '')).toHaveLength(2000);
    expect(ctx.agentNotes.replace(/\n\n\[\.\.\.truncated\]$/, '')).toHaveLength(4000);
  });
});
