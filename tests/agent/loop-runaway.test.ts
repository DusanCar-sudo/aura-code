import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/providers/factory.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/providers/factory.js')>();
  return {
    ...mod,
    getContextWindow: (m: string) => (m === 'fake-model' ? 200_000 : mod.getContextWindow(m)),
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentLoop } from '../../src/agent/loop.js';
import { PermissionSystem } from '../../src/safety/permissions.js';
import { loadProjectContext } from '../../src/agent/context.js';
import type { LLMProvider, StreamChunk, LLMResponse } from '../../src/providers/types.js';
import type { Display } from '../../src/cli/display.js';

/**
 * Reproduces the reported "bad session": glm-5.3-flash streamed an ~88k-token
 * planning monologue for a C++ game, never called a tool, and Aura let it run
 * to the end billing every token. The repetition guard misses it because the
 * text never repeats — every sentence is new free-association.
 */

const noopDisplay = new Proxy({} as Display, { get: () => () => {} });

class ScriptedProvider implements LLMProvider {
  name = 'Fake'; model = 'fake-model'; supportsTools = true;
  private last: LLMResponse | undefined;
  constructor(private queue: LLMResponse[]) {}
  async complete(): Promise<LLMResponse> {
    return { text: '- distilled fact', toolCalls: [], stopReason: 'done' };
  }
  async *stream(): AsyncGenerator<StreamChunk> {
    const next = this.queue.shift() ?? this.last;
    if (!next) throw new Error('queue empty');
    this.last = next;
    // Stream the text in realistic chunks so the char-count guard trips
    // mid-stream rather than only seeing one giant blob.
    for (let i = 0; i < next.text.length; i += 400) {
      yield { type: 'text', text: next.text.slice(i, i + 400) };
    }
    for (const tc of next.toolCalls) {
      yield { type: 'tool_start', name: tc.name, id: tc.id };
      yield { type: 'tool_end', call: tc };
    }
    yield { type: 'done', response: { ...next, usage: { inputTokens: 500, outputTokens: 200, cachedTokens: 0 } } };
  }
}

const say = (text: string): LLMResponse => ({ text, toolCalls: [], stopReason: 'done' });
const writeFile = (p: string): LLMResponse => ({
  text: '', stopReason: 'tools',
  toolCalls: [{ id: 'w1', name: 'write_file', input: { path: p, content: 'int main(){}' } }],
});

// A non-repeating wall of text, comfortably past the 32k-char cutoff.
const RUNAWAY = Array.from({ length: 900 }, (_, i) =>
  `Consideration ${i}: the ${i % 2 ? 'physics' : 'render'} pass should account for edge case ${i * 7} without regressing the earlier plan.`,
).join(' ');

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-runaway-'));
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
  vi.stubEnv('AURA_CONTEXT_STRATEGY', '');
  vi.stubEnv('AURA_SESSION_BUDGET', '');
});
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

const run = async (queue: LLMResponse[]) => {
  const ctx = await loadProjectContext(tmpDir);
  return runAgentLoop({
    provider: new ScriptedProvider(queue), task: 'make a C++ racing game', context: ctx,
    permissions: new PermissionSystem('auto'), display: noopDisplay,
    disableSpawn: true, checkpoints: false, maxTurns: 20,
  });
};

describe('a reply that runs away without calling a tool', () => {
  it('is cut off and not reported as success', async () => {
    expect(RUNAWAY.length).toBeGreaterThan(32_000);
    const r = await run([say(RUNAWAY)]);
    expect(r.success).toBe(false);
    expect(r.summary).toMatch(/ran away/i);
  });

  it('tells the model to stop narrating and act', async () => {
    const r = await run([say(RUNAWAY)]);
    const nudge = r.history.find(
      m => m.role === 'user' && /ran on for thousands of words/i.test(m.content ?? ''),
    );
    expect(nudge).toBeDefined();
  });

  it('does not feed the whole monologue back into history', async () => {
    const r = await run([say(RUNAWAY)]);
    const assistantTurns = r.history.filter(m => m.role === 'assistant');
    for (const m of assistantTurns) {
      expect((m.content ?? '').length).toBeLessThan(1_000);
    }
  });

  it('still records estimated usage for the cut-off turn', async () => {
    const r = await run([say(RUNAWAY)]);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
  });

  it('recovers when the model gets back on task', async () => {
    const r = await run([say(RUNAWAY), writeFile('main.cpp'), say('Wrote main.cpp — the game builds.')]);
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'main.cpp'))).toBe(true);
  });
});

describe('replies the runaway guard must leave alone', () => {
  it('a normal-length plan before a tool call is fine', async () => {
    const plan = 'Here is the plan: ' + 'step. '.repeat(300);   // ~1.8k chars
    expect(plan.length).toBeLessThan(32_000);
    const r = await run([say(plan + '\ndoing it'), writeFile('main.cpp'), say('Done.')]);
    expect(r.success).toBe(true);
    expect(r.history.some(m => m.role === 'user' && /ran on for thousands/i.test(m.content ?? '')))
      .toBe(false);
  });
});

describe('a run that spins: calls tools but changes nothing, turn after turn', () => {
  // Reading a resource that has never been seen is *exploration* — a real task
  // surveys new files before it writes, and the spin guard must leave it alone.
  // `chk` is used only by the mutating test below (reads between writes). The
  // spin shape is re-verifying the SAME artifact: in the real runaway (session
  // 24eebc25) the model re-read and re-screenshotted the already-done page with
  // a *different* call every turn, so detectStall (identical signatures) never
  // fired, but ~50 of 64 tool-turns changed nothing on disk. `rechecks` models
  // that as one file read at a different, overlapping window each turn:
  // signatures stay distinct (stall-blind), every read hits the same resource —
  // only the spin guard sees that nothing new is being learned.
  const chk = (n: number): LLMResponse => ({
    text: '', stopReason: 'tools',
    toolCalls: [{ id: `r${n}`, name: 'read_file', input: { path: `chk${n}.txt` } }],
  });
  const writePage = () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    fs.writeFileSync(path.join(tmpDir, 'page.txt'), lines.join('\n'));
  };
  const rechecks = (): LLMResponse[] => Array.from({ length: 16 }, (_, n) => ({
    text: '', stopReason: 'tools',
    toolCalls: [{
      id: `r${n}`, name: 'read_file',
      input: { path: path.join(tmpDir, 'page.txt'), start_line: 1 + n * 3, end_line: 40 + n * 3 },
    }],
  }));

  it('hard-stops a pure spinner instead of running to the turn cap', async () => {
    writePage();
    // 16 no-mutation turns re-reading the same page at different windows; the
    // spin guard must stop well before maxTurns (20). Reading distinct *new*
    // files would be exploration and run on; only this re-verification is a
    // spin, which is what the guard is for.
    const queue = rechecks();
    const r = await run(queue);
    expect(r.success).toBe(false);
    expect(r.toolCallCount).toBeLessThan(20);
    expect(r.summary).toMatch(/no change to disk/i);
  });

  it('tells the spinner to conclude or act', async () => {
    writePage();
    const queue = rechecks();
    const r = await run(queue);
    const nudges = r.history.filter(
      m => m.role === 'user' && /without changing anything|re-verifying|already-confirmed/i.test(m.content ?? ''),
    );
    expect(nudges.length).toBeGreaterThan(0);
  });

  it('leaves a run that mutates regularly alone', async () => {
    // A model that edits every couple of turns is slow but progressing — the
    // guard must not stop it.
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(tmpDir, `chk${i}.txt`), `v${i}`);
    const queue: LLMResponse[] = [
      chk(0), chk(1),
      { text: '', stopReason: 'tools', toolCalls: [{ id: 'w1', name: 'write_file', input: { path: 'a.cpp', content: 'int a(){}' } }] },
      chk(2), chk(3),
      { text: '', stopReason: 'tools', toolCalls: [{ id: 'w2', name: 'write_file', input: { path: 'b.cpp', content: 'int b(){}' } }] },
      say('Done building both files.'),
    ];
    const r = await run(queue);
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'a.cpp'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'b.cpp'))).toBe(true);
    // No spin correction should appear for genuinely progressing work.
    expect(r.history.some(m => m.role === 'user' && /without changing anything|re-verifying/i.test(m.content ?? '')))
      .toBe(false);
  });
});
