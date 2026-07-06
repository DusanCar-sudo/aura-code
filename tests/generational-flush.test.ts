import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HistoryMessage, LLMProvider } from '../src/providers/types.js';
import { getRecapGeneration } from '../src/agent/compactor.js';

vi.mock('../src/dream/dream.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/dream/dream.js')>();
  return { ...mod, distillText: vi.fn(mod.distillText) };
});

const { maybeRollover } = await import('../src/agent/generational-flush.js');
const { distillText } = await import('../src/dream/dream.js');

const recap = (content: string): HistoryMessage => ({ role: 'assistant', content });
const user = (content: string): HistoryMessage => ({ role: 'user', content });

function fakeProvider(text: string): LLMProvider {
  return {
    name: 'Fake', model: 'fake-model', supportsTools: false,
    async complete() { return { text, toolCalls: [], stopReason: 'done' }; },
    async *stream() { yield { type: 'done', response: { text, toolCalls: [], stopReason: 'done' } }; },
  } as unknown as LLMProvider;
}

describe('maybeRollover', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-flush-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('no-ops when there is no recap to flush', async () => {
    const history = [user('task'), user('just chatting')];
    const result = await maybeRollover(history, tmpDir, fakeProvider('- irrelevant'), {});
    expect(result.flushed).toBe(false);
    expect(history).toHaveLength(2);
  });

  it('flushes the recap to the dream store and resets generation to 0', async () => {
    const history: HistoryMessage[] = [
      user('original task'),
      recap('[Earlier conversation compacted (gen 3): 12 turns removed to stay within context limits.]\nConcept: refactored parser · Terms: parser, tokens\nLast thread: Tool results: [write_file]'),
      user('what next?'),
    ];
    expect(getRecapGeneration(history)).toBe(3);

    const provider = fakeProvider('- refactored the parser tokenizer\n- open thread: unit tests still failing');
    const result = await maybeRollover(history, tmpDir, provider, {
      executiveDigest: 'Recent state-altering actions already executed (do not repeat):\nwrite_file parser.ts',
      affectHint: 'Note: recent user messages show signs of frustration.',
    });

    expect(result.flushed).toBe(true);
    expect(result.flushPath).toBeDefined();
    expect(fs.existsSync(result.flushPath!)).toBe(true);
    expect(fs.readFileSync(result.flushPath!, 'utf8')).toContain('refactored the parser tokenizer');

    // Recap replaced by a pointer; generation reads back to 0 (no recap left).
    expect(getRecapGeneration(history)).toBe(0);
    expect(history).toHaveLength(3); // task, pointer, tail — same shape as before
    const pointer = history[1] as { content: string };
    expect(pointer.content).toContain('flushed to memory');
    expect(pointer.content).toContain(result.flushPath!);
    expect(pointer.content).toContain('do not repeat');
    expect(pointer.content).toContain('frustration');
    // The old recap's raw text is gone from in-context history.
    expect(pointer.content).not.toContain('Terms: parser, tokens');

    // Original task and tail messages are untouched.
    expect(history[0]).toEqual(user('original task'));
    expect(history[2]).toEqual(user('what next?'));
  });

  it('writes to a distinct file on each successive flush (no collision)', async () => {
    const h1: HistoryMessage[] = [user('task'), recap('[Earlier conversation compacted (gen 3): x]\nstuff')];
    const h2: HistoryMessage[] = [user('task'), recap('[Earlier conversation compacted (gen 3): y]\nmore stuff')];
    const provider = fakeProvider('- a fact');
    const r1 = await maybeRollover(h1, tmpDir, provider, {});
    const r2 = await maybeRollover(h2, tmpDir, provider, {});
    expect(r1.flushPath).not.toBe(r2.flushPath);
    expect(fs.existsSync(r1.flushPath!)).toBe(true);
    expect(fs.existsSync(r2.flushPath!)).toBe(true);
  });

  it('uses distillText (shared with runDream) rather than a bespoke prompt path', async () => {
    const history: HistoryMessage[] = [user('task'), recap('[Earlier conversation compacted (gen 3): x]\nstuff')];
    vi.mocked(distillText).mockClear();
    const result = await maybeRollover(history, tmpDir, fakeProvider('- fact'), {});
    expect(distillText).toHaveBeenCalledTimes(1);
    const call = vi.mocked(distillText).mock.calls[0][0];
    expect(call.userContent).toContain('stuff');
    // Whatever path maybeRollover reports is exactly the path it told
    // distillText to write to — no separate/duplicate write path.
    expect(call.outPath).toBe(result.flushPath);
  });
});
