import { describe, it, expect } from 'vitest';
import {
  runCommand, classify, LOCAL_COMMANDS, TERMINAL_ONLY, type CommandContext,
} from '../../web/src/lib/commands';

// ─────────────────────────────────────────────────────────────────────────────
// The bug these guard against:
//
// The `/` menu used to paste a command into the composer, which then went to
// the engine as an ordinary turn — so typing `:resume` sent the agent off to
// research the word "resume". A command must run, or say why it cannot. It
// must never reach the model.
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
  const seen = { notes: [] as string[], opened: [] as string[], newChats: 0, menus: 0 };
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
    ...over,
  };
  return { context, ...seen, seen };
}

describe('classify', () => {
  it('treats anything without a leading colon as not a command', () => {
    expect(classify('what does this project do?')).toBe('unknown');
    expect(classify('the ratio is 3:1')).toBe('unknown');
  });

  it('knows which commands run here', () => {
    for (const cmd of LOCAL_COMMANDS) expect(classify(cmd)).toBe('local');
  });

  it('knows which belong to the terminal', () => {
    for (const cmd of TERMINAL_ONLY) expect(classify(cmd)).toBe('terminal');
  });

  it('classifies an unrecognised colon-word as terminal, never as a prompt', () => {
    // The safe default: refuse and explain, rather than send it to the model.
    expect(classify(':nosuchcommand')).toBe('terminal');
  });

  it('ignores arguments when classifying', () => {
    expect(classify(':archmodel qwen3:4b')).toBe('terminal');
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
    for (const cmd of [...LOCAL_COMMANDS, ...TERMINAL_ONLY, ':unrecognised']) {
      expect(runCommand(cmd, ctx().context)).toBe(true);
    }
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

  it(':model, :provider and :apikey open the provider settings', () => {
    for (const cmd of [':model', ':provider', ':apikey']) {
      const c = ctx();
      runCommand(cmd, c.context);
      expect(c.seen.opened).toContain('settings:provider');
    }
  });

  it(':help opens the command menu', () => {
    const c = ctx();
    runCommand(':help', c.context);
    expect(c.seen.menus).toBe(1);
  });

  it('a terminal-only command explains itself and names itself', () => {
    const c = ctx();
    runCommand(':dream', c.context);
    expect(c.seen.notes[0]).toContain(':dream');
    expect(c.seen.notes[0]).toContain('cmd.terminalOnly');
  });

  it('is case-insensitive on the command itself', () => {
    const c = ctx();
    runCommand(':RESUME', c.context);
    expect(c.seen.opened).toContain('a');
  });
});
