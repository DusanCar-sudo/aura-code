import { describe, it, expect } from 'vitest';
import {
  runCommand, classify, LOCAL_COMMANDS, type CommandContext,
} from '../../web/src/lib/commands';

// ─────────────────────────────────────────────────────────────────────────────
// The bug these guard against:
//
// The `/` menu used to paste a command into the composer, which then went to
// the engine as an ordinary turn — so typing `:resume` sent the agent off to
// research the word "resume". A command must run, or say why it cannot. It
// must never reach the model.
//
// And "say why it cannot" was doing far too much work: this client could only
// answer fourteen commands from its own state and told the user the other
// fifty-two were terminal-only, which for most of them was never true. The
// engine now runs them (command.run → src/commands/core.ts), so the contract
// these guard is: local, or engine — and nothing silently in between.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A context that records what a command did.
 *
 * Counters live on an object rather than as bare numbers: Object.assign copies
 * a number by value, so a getter over a closed-over `let` would report the
 * value at construction time forever. Arrays happen to work by reference,
 * which is exactly the kind of asymmetry that makes a test lie.
 */
function ctx(over: Partial<CommandContext> = {}) {
  const seen = { notes: [] as string[], opened: [] as string[], engine: [] as string[], newChats: 0, menus: 0 };
  const context: CommandContext = {
    t: (k: string) => k,
    sessionId: 's1',
    conversations: [
      { sessionId: 'a', title: 'Newest', at: 3 },
      { sessionId: 'b', title: 'Older', at: 2 },
    ],
    messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }],
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
    newChat: () => { seen.newChats++; },
    openChat: (id) => { seen.opened.push(id); },
    note: (text) => { seen.notes.push(text); },
    openSettings: (tab) => { seen.opened.push(`settings:${tab}`); },
    openCommandMenu: () => { seen.menus++; },
    runOnEngine: async (command) => { seen.engine.push(command); return true; },
    ...over,
  };
  return { context, ...seen, seen };
}

describe('classify', () => {
  it('knows which commands this client answers itself', () => {
    for (const cmd of LOCAL_COMMANDS) expect(classify(cmd)).toBe('local');
  });

  it('sends everything else to the engine, including ones it has never heard of', () => {
    // The safe default is the engine, not the model: an unknown `:word` is
    // still a command, and command.run reports honestly when it cannot run it.
    expect(classify(':nosuchcommand')).toBe('engine');
    expect(classify(':dream')).toBe('engine');
    expect(classify('/stats')).toBe('engine');
  });

  it('ignores arguments when classifying', () => {
    expect(classify(':archmodel qwen3:4b')).toBe('engine');
    expect(classify(':resume  ')).toBe('local');
  });
});

describe('runCommand', () => {
  it('refuses to handle ordinary prose, so it reaches the model', () => {
    const c = ctx();
    expect(runCommand('explain this repo', c.context)).toBe(false);
    expect(c.seen.notes).toHaveLength(0);
  });

  it('handles every command it claims to, so none can fall through to a turn', () => {
    for (const cmd of [...LOCAL_COMMANDS, ':dream', ':graph', '/stats', ':unrecognised']) {
      expect(runCommand(cmd, ctx().context)).toBe(true);
    }
  });

  it('sends a slash command to the engine rather than to the model', () => {
    // /stats, /cost and /context were checked nowhere: submit() only looked
    // for a leading ':', so the slash half of the set was sent as prose.
    const c = ctx();
    expect(runCommand('/stats', c.context)).toBe(true);
    expect(c.seen.engine).toEqual(['/stats']);
    expect(c.seen.notes).toHaveLength(0);
  });

  it(':resume opens the most recent conversation', () => {
    const c = ctx();
    runCommand(':resume', c.context);
    expect(c.seen.opened).toContain('a');
  });

  it(':resume says so when there is nothing to resume', () => {
    const c = ctx({ conversations: [] });
    runCommand(':resume', c.context);
    expect(c.seen.opened).toHaveLength(0);
    expect(c.seen.notes[0]).toBe('cmd.noSessions');
  });

  it(':new starts a conversation', () => {
    const c = ctx();
    runCommand(':new', c.context);
    expect(c.seen.newChats).toBe(1);
  });

  it(':sessions lists them, and marks the current one', () => {
    const c = ctx({ sessionId: 'b' });
    runCommand(':sessions', c.context);
    expect(c.seen.notes[0]).toContain('Newest');
    expect(c.seen.notes[0]).toContain('Older');
    expect(c.seen.notes[0]).toMatch(/Older\s+←/);
  });

  it(':history counts user turns, not messages', () => {
    const c = ctx();
    runCommand(':history', c.context);
    expect(c.seen.notes[0]).toMatch(/^2 /);
  });

  it(':context reports usage, and says when there is none', () => {
    const c = ctx();
    runCommand(':context', c.context);
    expect(c.seen.notes[0]).toContain('100');
    const empty = ctx({ usage: null });
    runCommand(':context', empty.context);
    expect(empty.seen.notes[0]).toBe('cmd.noUsage');
  });

  it(':model, :provider and :apikey open the models settings tab', () => {
    for (const cmd of [':model', ':provider', ':apikey']) {
      const c = ctx();
      runCommand(cmd, c.context);
      expect(c.seen.opened).toContain('settings:models');
    }
  });

  it(':help opens the command menu', () => {
    const c = ctx();
    runCommand(':help', c.context);
    expect(c.seen.menus).toBe(1);
  });

  it('runs a command it does not own on the engine, verbatim and with its arguments', () => {
    const c = ctx();
    runCommand(':mine --stats', c.context);
    expect(c.seen.engine).toEqual([':mine --stats']);
    // Nothing is asserted locally: the answer comes back from the engine.
    expect(c.seen.notes).toHaveLength(0);
  });

  it('sends an unrecognised command to the engine instead of guessing', () => {
    const c = ctx();
    runCommand(':nosuchcommand', c.context);
    expect(c.seen.engine).toEqual([':nosuchcommand']);
  });

  it('is case-insensitive on the command itself', () => {
    const c = ctx();
    runCommand(':RESUME', c.context);
    expect(c.seen.opened).toContain('a');
  });
});
