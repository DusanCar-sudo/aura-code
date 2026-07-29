import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createGazelleChat } from '../src/agent/gazelle-chat.js';
import { handleModeCommand } from '../src/cli/repl-mode-commands.js';
import { HELP_TEXT } from '../src/cli/help-data.js';
import type {
  LLMProvider, HistoryMessage, StreamChunk, LLMResponse, ToolDefinition,
} from '../src/providers/types.js';
import type { Display } from '../src/cli/display.js';

/**
 * What these cover: :gazelle was listed at the top of :help's "Modes" section
 * but implemented only inside the --gazelle orchestrator's stdin loops, so
 * typing it into the ordinary REPL sent the literal string ":gazelle" to the
 * model as a task. Two things had to change, and both are asserted here — a
 * turn that runs without a line reader (so the TUI can host one), and mode
 * commands in a module a test can actually import.
 */

interface Call { system: string; history: HistoryMessage[]; tools: ToolDefinition[] }

class RecordingProvider implements LLMProvider {
  name = 'Fake';
  supportsTools = true;
  readonly calls: Call[] = [];
  constructor(public model: string, private responses: LLMResponse[]) {}
  async complete(): Promise<LLMResponse> {
    return { text: '', toolCalls: [], stopReason: 'done' };
  }
  async *stream(
    system: string, history: HistoryMessage[], tools: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    this.calls.push({ system, history: [...history], tools });
    const next = this.responses.shift();
    if (!next) throw new Error('No more responses queued');
    if (next.text) yield { type: 'text', text: next.text };
    yield { type: 'done', response: next };
  }
}

class FailingProvider implements LLMProvider {
  name = 'Fake';
  model = 'fake-model';
  supportsTools = true;
  async complete(): Promise<LLMResponse> {
    return { text: '', toolCalls: [], stopReason: 'done' };
  }
  async *stream(): AsyncGenerator<StreamChunk> {
    throw new Error('upstream exploded');
  }
}

const reply = (text: string, usage?: { inputTokens: number; outputTokens: number }): LLMResponse => ({
  text, toolCalls: [], stopReason: 'done',
  ...(usage ? { usage: { ...usage, cachedTokens: 0 } } : {}),
});

/** A display that records what the turn told the user. */
function spyDisplay() {
  const calls = { errors: [] as string[], warnings: [] as string[], streamed: [] as string[] };
  const display = new Proxy({} as Display, {
    get: (_t, prop) => {
      if (prop === 'error') return (m: string) => calls.errors.push(m);
      if (prop === 'warning') return (m: string) => calls.warnings.push(m);
      if (prop === 'streamText') return (t: string) => calls.streamed.push(t);
      return () => {};
    },
  });
  return { display, calls };
}

describe('Gazelle chat turns (no reader required)', () => {
  it('sends no tool schemas — the whole point of the lean path', async () => {
    const provider = new RecordingProvider('fake-model', [reply('hey')]);
    const chat = createGazelleChat({ provider, display: spyDisplay().display });

    await chat.respond('hello');

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].tools).toEqual([]);
  });

  it('carries the exchange in history and seeds from a prior conversation', async () => {
    const provider = new RecordingProvider('fake-model', [reply('sure')]);
    const chat = createGazelleChat({
      provider,
      display: spyDisplay().display,
      initialHistory: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'noted' }],
    });

    await chat.respond('and now?');

    expect(chat.history.map(m => m.content)).toEqual(['earlier', 'noted', 'and now?', 'sure']);
    // The seed is copied, not adopted: the caller's array must not grow under it.
    expect(provider.calls[0].history).toHaveLength(3);
  });

  it('reports the provider-billed tokens and totals them across turns', async () => {
    const provider = new RecordingProvider('fake-model', [
      reply('one', { inputTokens: 120, outputTokens: 8 }),
      reply('two', { inputTokens: 140, outputTokens: 12 }),
    ]);
    const chat = createGazelleChat({ provider, display: spyDisplay().display });

    const first = await chat.respond('a');
    await chat.respond('b');

    expect(first.inputTokens).toBe(120);
    expect(chat.totals()).toEqual({ inputTokens: 260, outputTokens: 20, messages: 2 });
    expect(chat.statsLine()).toContain('280 tokens');
  });

  it('estimates tokens when the provider reports no usage', async () => {
    const provider = new RecordingProvider('fake-model', [reply('a fairly wordy answer')]);
    const chat = createGazelleChat({ provider, display: spyDisplay().display });

    const turn = await chat.respond('hi');

    expect(turn.inputTokens).toBeGreaterThan(0);
    expect(turn.outputTokens).toBeGreaterThan(0);
  });

  it('flags a reply that asks for tools, and leaves ordinary chat alone', async () => {
    const provider = new RecordingProvider('fake-model', [
      reply("I'd need to look at the file — want me to switch to coder mode?"),
      reply('Rust is a systems language with no garbage collector.'),
    ]);
    const chat = createGazelleChat({ provider, display: spyDisplay().display });

    expect((await chat.respond('why does auth fail?')).needsTools).toBe(true);
    expect((await chat.respond('what is rust?')).needsTools).toBe(false);
  });

  it('reports a provider failure as a failed turn instead of throwing', async () => {
    const { display, calls } = spyDisplay();
    const chat = createGazelleChat({ provider: new FailingProvider(), display });

    const turn = await chat.respond('hello');

    expect(turn.failed).toBe(true);
    expect(turn.text).toBe('');
    expect(calls.errors.join(' ')).toContain('Provider error');
  });

  it('re-resolves the provider each turn so a mid-conversation :model applies', async () => {
    // The REPL passes a thunk for exactly this: the chat outlives any one
    // provider instance, and a model switch must reach the next reply.
    const first = new RecordingProvider('model-a', [reply('from a')]);
    const second = new RecordingProvider('model-b', [reply('from b')]);
    let current: LLMProvider = first;
    const chat = createGazelleChat({ provider: () => current, display: spyDisplay().display });

    await chat.respond('one');
    current = second;
    await chat.respond('two');

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });

  describe('session persistence', () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-gazelle-chat-')); });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('writes the conversation to sessionPath after each turn', async () => {
      const sessionPath = path.join(tmpDir, 'gazelle-x.json');
      const provider = new RecordingProvider('fake-model', [reply('saved')]);
      const chat = createGazelleChat({ provider, display: spyDisplay().display, sessionPath });

      await chat.respond('remember this');

      const saved = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      expect(JSON.stringify(saved)).toContain('remember this');
    });

    it('survives an unwritable session path', async () => {
      const provider = new RecordingProvider('fake-model', [reply('ok')]);
      const chat = createGazelleChat({
        provider, display: spyDisplay().display,
        sessionPath: path.join(tmpDir, 'no', 'such', 'dir', 'x.json'),
      });

      await expect(chat.respond('hi')).resolves.toMatchObject({ failed: false });
    });
  });
});

describe('REPL mode commands', () => {
  const ctxIn = (mode: 'coder' | 'gazelle') => {
    const warnings: string[] = [];
    return { ctx: { mode, display: { warning: (m: string) => warnings.push(m) } }, warnings };
  };

  it(':gazelle from coder mode asks for the switch', () => {
    const { ctx } = ctxIn('coder');
    expect(handleModeCommand(':gazelle', ctx)).toEqual({ handled: true, newMode: 'gazelle' });
  });

  it(':coder from gazelle mode asks for the switch', () => {
    const { ctx } = ctxIn('gazelle');
    expect(handleModeCommand(':coder', ctx)).toEqual({ handled: true, newMode: 'coder' });
  });

  it('says so instead of switching when already in that mode', () => {
    const a = ctxIn('gazelle');
    expect(handleModeCommand(':gazelle', a.ctx)).toEqual({ handled: true });
    expect(a.warnings.join(' ')).toMatch(/already/i);

    const b = ctxIn('coder');
    expect(handleModeCommand(':coder', b.ctx)).toEqual({ handled: true });
    expect(b.warnings.join(' ')).toMatch(/already/i);
  });

  it('lets anything else through to the rest of the REPL', () => {
    const { ctx } = ctxIn('coder');
    expect(handleModeCommand(':gazelles', ctx)).toBeNull();
    expect(handleModeCommand('fix the login bug', ctx)).toBeNull();
    expect(handleModeCommand(':help', ctx)).toBeNull();
  });

  it('handles every command :help advertises under "Modes"', () => {
    // The actual bug: :help listed both commands while the REPL implemented
    // neither, so each was sent to the model as a task. An unhandled command
    // returns null here, which is precisely that fall-through.
    const start = HELP_TEXT.findIndex(l => l.includes('── Modes'));
    expect(start).toBeGreaterThanOrEqual(0);

    const advertised: string[] = [];
    for (const line of HELP_TEXT.slice(start + 1)) {
      if (line.includes('── ')) break;                 // next section
      const m = /^\s*(:[a-z-]+)\s{2,}/.exec(line);
      if (m) advertised.push(m[1]);
    }
    expect(advertised.sort()).toEqual([':coder', ':gazelle']);

    for (const cmd of advertised) {
      // From the other mode, so each one reports a real switch rather than
      // the "already there" no-op.
      const other = cmd === ':gazelle' ? 'coder' : 'gazelle';
      expect(handleModeCommand(cmd, ctxIn(other as 'coder' | 'gazelle').ctx))
        .toMatchObject({ handled: true, newMode: cmd.slice(1) });
    }
  });
});
