import { describe, it, expect } from 'vitest';
import * as os from 'os';
import {
  expandCommand, expandAgentTask, expandSkillTask, findInvocable, splitArgs,
} from '../src/plugins/commands.js';
import type { LoadedPlugin } from '../src/plugins/types.js';

const cwd = os.tmpdir();

function plugin(name: string, over: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    name, path: `/fake/${name}`, manifest: { name },
    commands: [], agents: [], skills: [], hooks: [], mcpServerCount: 0,
    ...over,
  };
}

describe('splitArgs', () => {
  it('splits on whitespace and honors quotes', () => {
    expect(splitArgs('a "b c" \'d e\' f')).toEqual(['a', 'b c', 'd e', 'f']);
    expect(splitArgs('')).toEqual([]);
  });
});

describe('expandCommand', () => {
  it('substitutes $ARGUMENTS and positionals', async () => {
    const out = await expandCommand(
      { body: 'Review $1 against $2. Full: $ARGUMENTS' },
      'main develop',
      { cwd, mode: 'auto' },
    );
    expect(out).toBe('Review main against develop. Full: main develop');
  });

  it('missing positionals become empty strings', async () => {
    const out = await expandCommand({ body: 'a=$1 b=$2' }, 'only', { cwd, mode: 'auto' });
    expect(out).toBe('a=only b=');
  });

  it('appends arguments when the body has no placeholders', async () => {
    const out = await expandCommand({ body: 'Fix the bug.' }, 'in auth.ts', { cwd, mode: 'auto' });
    expect(out).toBe('Fix the bug.\n\nARGUMENTS: in auth.ts');
  });

  it('runs !`cmd` preprocessing in auto mode', async () => {
    const out = await expandCommand(
      { body: 'Current dir contents:\n!`echo hello-from-shell`' },
      '',
      { cwd, mode: 'auto' },
    );
    expect(out).toContain('hello-from-shell');
    expect(out).not.toContain('!`');
  });

  it('skips !`cmd` in read-only mode', async () => {
    const out = await expandCommand({ body: '!`echo nope`' }, '', { cwd, mode: 'read-only' });
    expect(out).toContain('skipped in read-only mode');
    expect(out).not.toContain('!`');
  });

  it('normal mode asks confirmFn and respects denial', async () => {
    const asked: string[] = [];
    const denied = await expandCommand(
      { body: '!`echo secret`' }, '',
      { cwd, mode: 'normal', confirmFn: async m => { asked.push(m); return false; } },
    );
    expect(asked[0]).toContain('echo secret');
    expect(denied).toContain('declined');

    const approved = await expandCommand(
      { body: '!`echo granted`' }, '',
      { cwd, mode: 'normal', confirmFn: async () => true },
    );
    expect(approved).toBe('granted');
  });

  it('normal mode with no confirmFn defaults to deny', async () => {
    const out = await expandCommand({ body: '!`echo x`' }, '', { cwd, mode: 'normal' });
    expect(out).toContain('declined');
  });

  it('reports failed preprocessing commands inline', async () => {
    const out = await expandCommand({ body: '!`exit 3`' }, '', { cwd, mode: 'auto' });
    expect(out).toContain('shell preprocessing failed');
  });
});

describe('findInvocable', () => {
  const plugins: LoadedPlugin[] = [
    plugin('pr-tools', {
      commands: [
        { name: 'review', pluginName: 'pr-tools', body: 'B', filePath: '/f' },
        { name: 'git:commit', pluginName: 'pr-tools', body: 'C', filePath: '/f' },
      ],
      agents: [{ name: 'security-reviewer', pluginName: 'pr-tools', systemPrompt: 'S', filePath: '/f' }],
      skills: [{ name: 'tdd', pluginName: 'pr-tools', body: 'T', dir: '/d' }],
    }),
    plugin('other', {
      commands: [{ name: 'review', pluginName: 'other', body: 'B2', filePath: '/f' }],
    }),
  ];

  it('resolves qualified plugin:command names', () => {
    const m = findInvocable(plugins, 'pr-tools:review');
    expect(m).toMatchObject({ kind: 'command', command: { pluginName: 'pr-tools' } });
  });

  it('resolves subdir-namespaced commands via the colon fallback', () => {
    const m = findInvocable(plugins, 'git:commit');
    expect(m).toMatchObject({ kind: 'command', command: { name: 'git:commit' } });
  });

  it('flags ambiguous bare names with candidates', () => {
    const m = findInvocable(plugins, 'review');
    expect(m).toMatchObject({ kind: 'ambiguous' });
    expect((m as { candidates: string[] }).candidates.sort()).toEqual(['other:review', 'pr-tools:review']);
  });

  it('falls back to skills, then agents', () => {
    expect(findInvocable(plugins, 'tdd')).toMatchObject({ kind: 'skill' });
    expect(findInvocable(plugins, 'security-reviewer')).toMatchObject({ kind: 'agent' });
  });

  it('strips a leading slash and returns null for unknown names', () => {
    expect(findInvocable(plugins, '/tdd')).toMatchObject({ kind: 'skill' });
    expect(findInvocable(plugins, 'nope')).toBeNull();
  });
});

describe('agent and skill expansion', () => {
  it('agent system prompt preambles the task', () => {
    const out = expandAgentTask(
      { name: 'a', pluginName: 'p', systemPrompt: 'You are X.', filePath: '/f' },
      'audit the auth flow',
    );
    expect(out).toBe('You are X.\n\n---\n\naudit the auth flow');
  });

  it('skill body wraps the task with provenance', () => {
    const out = expandSkillTask(
      { name: 's', pluginName: 'p', body: 'Write tests first.', dir: '/d' },
      'add a parser',
    );
    expect(out).toContain('plugin "p"');
    expect(out).toContain('Write tests first.');
    expect(out.endsWith('add a parser')).toBe(true);
  });
});
