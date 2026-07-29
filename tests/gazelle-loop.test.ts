import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';

import { runGazelleLoop, type LoopOutcome } from '../src/agent/gazelle-loop.js';
import type {
  LLMProvider, HistoryMessage, StreamChunk, LLMResponse,
} from '../src/providers/types.js';
import type { Display } from '../src/cli/display.js';

/**
 * Regression cover for the reader-driven loop after its turn machinery moved to
 * gazelle-chat.ts (so the TUI could drive the same turns). These assert the part
 * that stayed here: reading lines, the mode commands, and the escalation offer.
 */

class FakeProvider implements LLMProvider {
  name = 'Fake';
  model = 'fake-model';
  supportsTools = true;
  constructor(private responses: string[]) {}
  async complete(): Promise<LLMResponse> {
    return { text: '', toolCalls: [], stopReason: 'done' };
  }
  async *stream(_s: string, _h: HistoryMessage[]): AsyncGenerator<StreamChunk> {
    const text = this.responses.shift() ?? 'ok';
    yield { type: 'text', text };
    yield {
      type: 'done',
      response: {
        text, toolCalls: [], stopReason: 'done',
        // Deliberately tiny: the session-end memory rewrite is gated on total
        // tokens, and it would make a real provider call.
        usage: { inputTokens: 12, outputTokens: 4, cachedTokens: 0 },
      },
    };
  }
}

function spyDisplay() {
  const warnings: string[] = [];
  const display = new Proxy({} as Display, {
    get: (_t, prop) => (prop === 'warning' ? (m: string) => warnings.push(m) : () => {}),
  });
  return { display, warnings };
}

/** Drive the loop over piped streams, feeding `lines` in order. `end` closes
 *  stdin afterwards (the EOF the loop treats as quit). */
function drive(provider: LLMProvider, lines: string[], end: boolean) {
  const input = new PassThrough();
  const output = new PassThrough();
  const { display, warnings } = spyDisplay();
  // The loop's synchronous prefix attaches the reader, so writes land after it.
  const done: Promise<LoopOutcome> = runGazelleLoop({
    provider, display, input, output, writeMemoryOnExit: false,
  });
  for (const l of lines) input.write(`${l}\n`);
  if (end) input.end();
  return { done, warnings, output };
}

describe('Gazelle loop over a line reader', () => {
  it('answers piped turns and exits on EOF with the conversation', async () => {
    const { done } = drive(new FakeProvider(['hello there', 'still here']), ['hi', 'again'], true);

    const outcome = await done;

    expect(outcome.action).toBe('exit');
    expect(outcome.history.map(m => m.content))
      .toEqual(['hi', 'hello there', 'again', 'still here']);
  });

  it(':coder hands off, carrying history to the coder loop', async () => {
    const { done } = drive(new FakeProvider(['sure']), ['what is rust?', ':coder'], false);

    const outcome = await done;

    expect(outcome.action).toBe('switch');
    expect(outcome).not.toHaveProperty('carryMessage');
    expect(outcome.history).toHaveLength(2);
  });

  it(':gazelle stays put and keeps answering', async () => {
    const { done, warnings } = drive(new FakeProvider(['answered anyway']), [':gazelle', 'hi'], true);

    const outcome = await done;

    expect(warnings.some(w => /already/i.test(w))).toBe(true);
    expect(outcome.history.map(m => m.content)).toEqual(['hi', 'answered anyway']);
  });

  it('offers the switch when its own answer says it needs tools, and Enter accepts', async () => {
    const provider = new FakeProvider(["I'd need to look at the file to say."]);
    // Empty line = Enter = accept the offer.
    const { done } = drive(provider, ['why does login fail?', ''], false);

    const outcome = await done;

    expect(outcome.action).toBe('switch');
    // The question that triggered the offer is what coder mode picks up.
    expect(outcome).toMatchObject({ carryMessage: 'why does login fail?' });
  });

  it('treats a non-acceptance as the next conversational turn, not a switch', async () => {
    const provider = new FakeProvider([
      "I'd need to look at the file to say.",
      'Rust has no garbage collector.',
    ]);
    const { done } = drive(provider, ['why does login fail?', 'no, tell me about rust'], true);

    const outcome = await done;

    expect(outcome.action).toBe('exit');
    expect(outcome.history.map(m => m.content)).toEqual([
      'why does login fail?', "I'd need to look at the file to say.",
      'no, tell me about rust', 'Rust has no garbage collector.',
    ]);
  });
});
