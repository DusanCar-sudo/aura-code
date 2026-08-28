import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  handleArchimedesCommand,
  type ArchimedesCommandCtx,
} from '../src/cli/repl-archimedes-commands.js';

/**
 * The gap this closes: these branches lived in cli/index.ts, which self-executes
 * on import, so nothing could assert that they return an override at all. Each
 * command's entire observable effect *is* the returned flag — the REPL loop
 * copies it into its own state — so a branch that printed its confirmation and
 * returned a bare `{ handled: true }` would look correct to a user right up
 * until the next turn routed the old way.
 */

vi.mock('../src/archimedes/index.js', () => ({
  getEpisodeStats: vi.fn(async () => ({
    archimedesSuccesses: 3,
    archimedesFailures: 1,
  })),
}));

const PROJECT = '/fake/project';

function makeCtx(over: Partial<ArchimedesCommandCtx> = {}): ArchimedesCommandCtx & {
  messages: { kind: 'success' | 'warning'; msg: string }[];
} {
  const messages: { kind: 'success' | 'warning'; msg: string }[] = [];
  return {
    projectRoot: PROJECT,
    archimedesModelOverride: undefined,
    display: {
      success: (msg: string) => { messages.push({ kind: 'success', msg }); },
      warning: (msg: string) => { messages.push({ kind: 'warning', msg }); },
    },
    messages,
    ...over,
  };
}

describe('REPL Archimedes commands return their override', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it(':small1 turns the override on and reports the recorded score', async () => {
    const c = makeCtx();
    const r = await handleArchimedesCommand(':small1', c);
    expect(r).toEqual({ handled: true, newSmall1Override: true });
    // 3 of 4 attempts — the number is the whole point of the message, since it
    // is what the user is choosing to override.
    expect(c.messages[0]!.msg).toContain('75% over 4 attempt(s)');
  });

  it(':small1 on is the same command as :small1', async () => {
    expect(await handleArchimedesCommand(':small1 on', makeCtx()))
      .toEqual({ handled: true, newSmall1Override: true });
  });

  it(':small1 off turns it back off', async () => {
    expect(await handleArchimedesCommand(':small1 off', makeCtx()))
      .toEqual({ handled: true, newSmall1Override: false });
  });

  it(':archon and :archoff toggle the alternator override', async () => {
    expect(await handleArchimedesCommand(':archon', makeCtx()))
      .toEqual({ handled: true, newArchimedesOverride: true });
    expect(await handleArchimedesCommand(':archoff', makeCtx()))
      .toEqual({ handled: true, newArchimedesOverride: false });
  });

  it(':archmodel <tag> reports the tag, trimmed', async () => {
    expect(await handleArchimedesCommand(':archmodel  qwen3-vl:4b ', makeCtx()))
      .toEqual({ handled: true, newArchimedesModelOverride: 'qwen3-vl:4b' });
  });

  it(':archmodel with a blank argument warns instead of setting an empty model', async () => {
    const c = makeCtx();
    const r = await handleArchimedesCommand(':archmodel    ', c);
    expect(r).toEqual({ handled: true });
    expect(c.messages[0]!.kind).toBe('warning');
  });

  it('bare :archmodel reports the current override', async () => {
    const c = makeCtx({ archimedesModelOverride: 'lmstudio/qwen/qwen3-1.7b' });
    expect(await handleArchimedesCommand(':archmodel', c)).toEqual({ handled: true });
    expect(c.messages[0]!.msg).toContain('lmstudio/qwen/qwen3-1.7b');
  });

  it('bare :archmodel says where the value comes from when none is set', async () => {
    const c = makeCtx();
    await handleArchimedesCommand(':archmodel', c);
    expect(c.messages[0]!.msg).toContain('.aura.json');
  });

  it('returns null for anything else, so the caller keeps matching', async () => {
    expect(await handleArchimedesCommand(':help', makeCtx())).toBeNull();
    expect(await handleArchimedesCommand(':small1x', makeCtx())).toBeNull();
    expect(await handleArchimedesCommand('write me a parser', makeCtx())).toBeNull();
  });
});
