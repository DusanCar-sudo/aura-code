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
 * The failure a user reported verbatim from a Termux session: the model emits
 * a tool call as text ("<|toolcallstart|>[runshell(...)]<|toolcall_end|>"), the
 * provider parses nothing, the loop sees "done" with no tool calls, and returns
 * success while nothing ran. Plus its cousins — claiming a file was created
 * when it is not on disk, and "the tests pass" with nothing executed.
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
    if (next.text) yield { type: 'text', text: next.text };
    for (const tc of next.toolCalls) {
      yield { type: 'tool_start', name: tc.name, id: tc.id };
      yield { type: 'tool_end', call: tc };
    }
    yield { type: 'done', response: { ...next, usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0 } } };
  }
}

const say = (text: string): LLMResponse => ({ text, toolCalls: [], stopReason: 'done' });
const writeFile = (p: string, content = 'x'): LLMResponse => ({
  text: '', stopReason: 'tools',
  toolCalls: [{ id: 'w1', name: 'write_file', input: { path: p, content } }],
});
const shell = (command: string): LLMResponse => ({
  text: '', stopReason: 'tools',
  toolCalls: [{ id: 's1', name: 'run_shell', input: { command } }],
});

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-ungrounded-'));
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
  vi.stubEnv('AURA_CONTEXT_STRATEGY', '');
  vi.stubEnv('AURA_SESSION_BUDGET', '');
});
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

const run = async (queue: LLMResponse[]) => {
  const ctx = await loadProjectContext(tmpDir);
  return runAgentLoop({
    provider: new ScriptedProvider(queue), task: 'create the helper', context: ctx,
    permissions: new PermissionSystem('auto'), display: noopDisplay,
    disableSpawn: true, checkpoints: false, maxTurns: 12,
  });
};

describe('a tool call emitted as text', () => {
  const LEAK = say(
    'Let me try one more thing:\n' +
    `<|toolcallstart|>[runshell(command='echo "test" > /tmp/test.txt')]<|toolcall_end|>`,
  );

  it('is not reported as success', async () => {
    const r = await run([LEAK]);
    expect(r.success).toBe(false);
    expect(r.summary).toMatch(/unverified|did not run/i);
  });

  it('tells the model the call never executed', async () => {
    const r = await run([LEAK]);
    const nudge = r.history.find(
      m => m.role === 'user' && /written as text/i.test(m.content ?? ''),
    );
    expect(nudge).toBeDefined();
  });

  it('recovers when the model re-emits it as a real tool call', async () => {
    const r = await run([LEAK, writeFile('helper.ts'), say('Done — wrote the helper.')]);
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'helper.ts'))).toBe(true);
  });
});

describe('claiming a file that is not on disk', () => {
  it('fails the run and names the missing file', async () => {
    const r = await run([say('I created `src/helper.ts` with the implementation.')]);
    expect(r.success).toBe(false);
    expect(r.summary).toMatch(/src\/helper\.ts/);
  });

  it('is a success when the file actually exists', async () => {
    const r = await run([writeFile('src/helper.ts'), say('Created `src/helper.ts` for you.')]);
    expect(r.success).toBe(true);
    expect(r.history.some(m => m.role === 'user' && /not exist on disk/i.test(m.content ?? '')))
      .toBe(false);
  });
});

describe('claiming verification that never ran', () => {
  it('pushes back when code changed but nothing was executed', async () => {
    const r = await run([writeFile('src/helper.ts'), say('Wrote the helper. All tests pass.')]);
    const nudge = r.history.find(
      m => m.role === 'user' && /did not run them/i.test(m.content ?? ''),
    );
    expect(nudge).toBeDefined();
    expect(r.success).toBe(false);
  });

  it('is satisfied once the tests are actually run', async () => {
    const r = await run([
      writeFile('src/helper.ts'),
      shell('npm test'),
      say('Wrote the helper and ran the suite — all tests pass.'),
    ]);
    expect(r.success).toBe(true);
  });

  it('leaves a pure explanation alone', async () => {
    const r = await run([say('The build already passes; nothing needs changing here.')]);
    expect(r.success).toBe(true);
  });
});
