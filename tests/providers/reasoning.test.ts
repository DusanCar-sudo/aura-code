import { describe, it, expect } from 'vitest';
import { ThinkTagStripper, readReasoningField, resolveAnswer } from '../../src/providers/reasoning.js';

describe('readReasoningField', () => {
  it('reads the Ollama /v1 spelling', () => {
    expect(readReasoningField({ reasoning: 'Thinking Process:' })).toBe('Thinking Process:');
  });

  it('reads the reasoning_content spelling', () => {
    expect(readReasoningField({ reasoning_content: 'step 1' })).toBe('step 1');
  });

  it('is empty for ordinary deltas and non-objects', () => {
    expect(readReasoningField({ content: 'hi' })).toBe('');
    expect(readReasoningField(null)).toBe('');
    expect(readReasoningField(undefined)).toBe('');
    expect(readReasoningField({ reasoning: 42 })).toBe('');
  });
});

describe('ThinkTagStripper', () => {
  const drain = (s: ThinkTagStripper, chunks: string[]) =>
    chunks.map(c => s.push(c)).join('') + s.flush();

  it('passes ordinary content through untouched', () => {
    const s = new ThinkTagStripper();
    expect(drain(s, ['Hello ', 'world'])).toBe('Hello world');
    expect(s.reasoningText).toBe('');
  });

  it('strips an in-band think block and keeps the answer', () => {
    const s = new ThinkTagStripper();
    expect(drain(s, ['<think>let me work it out</think>The answer is 36'])).toBe('The answer is 36');
    expect(s.reasoningText).toBe('let me work it out');
  });

  it('handles a tag split across chunk boundaries', () => {
    const s = new ThinkTagStripper();
    // The '<' lands at the end of one chunk and 'think>' opens the next.
    expect(drain(s, ['before <', 'think>hidden</thi', 'nk>after'])).toBe('before after');
    expect(s.reasoningText).toBe('hidden');
  });

  it('does not withhold a bare < that is not a tag', () => {
    const s = new ThinkTagStripper();
    expect(drain(s, ['if a < b then'])).toBe('if a < b then');
  });

  it('treats an unterminated think block as reasoning, not answer', () => {
    // Budget ran out mid-thought — emitting the trace as the answer would be
    // exactly the leak this exists to prevent.
    const s = new ThinkTagStripper();
    expect(drain(s, ['<think>still reasoning and then cut off'])).toBe('');
    expect(s.reasoningText).toBe('still reasoning and then cut off');
  });

  it('supports the <thinking> spelling', () => {
    const s = new ThinkTagStripper();
    expect(drain(s, ['<thinking>x</thinking>done'])).toBe('done');
  });

  it('handles multiple blocks', () => {
    const s = new ThinkTagStripper();
    expect(drain(s, ['a<think>1</think>b<think>2</think>c'])).toBe('abc');
    expect(s.reasoningText).toBe('12');
  });
});

describe('resolveAnswer', () => {
  it('prefers content whenever it exists', () => {
    // The real gemma-archimedes-gen2 shape at a sufficient budget: a short
    // content ("36") alongside a long reasoning trace. Content must win.
    expect(resolveAnswer('36', 'Thinking Process: ... 0.15 x 240 = 36')).toBe('36');
  });

  it('returns a System Error when the thinking phase consumed the budget', () => {
    // Measured: 271 reasoning chunks, zero content chunks. Returning raw reasoning
    // causes runaway generation loops. We now return an explicit error string.
    expect(resolveAnswer('', 'Thinking Process: 1. Identify the goal')).toBe('[System Error: Model exhausted token budget during reasoning phase. No final answer was provided.]');
  });

  it('stays empty when there is genuinely nothing', () => {
    expect(resolveAnswer('', '')).toBe('');
    expect(resolveAnswer('   ', '  ')).toBe('   ');
  });
});
