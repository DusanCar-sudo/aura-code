import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSteeringInbox, formatSteering } from '../../src/agent/steering.js';
import { runAgentLoop } from '../../src/agent/loop.js';
import { PermissionSystem } from '../../src/safety/permissions.js';
import { loadProjectContext } from '../../src/agent/context.js';
import type {
  LLMProvider, HistoryMessage, StreamChunk, LLMResponse,
} from '../../src/providers/types.js';
import type { Display } from '../../src/cli/display.js';

const noopDisplay: Display = {
  agentThinking: () => {},
  streamText: () => {},
  streamEnd: () => {},
  toolStart: () => {},
  toolCall: () => {},
  toolResult: () => {},
  toolBlocked: () => {},
  warning: () => {},
  success: () => {},
  error: () => {},
  header: () => {},
  summary: () => {},
  showPlan: () => {},
  stepStarted: () => {},
  stepCompleted: () => {},
};

describe('createSteeringInbox', () => {
  it('drains what was posted, in order, and empties itself', () => {
    const inbox = createSteeringInbox();
    inbox.post('also add tests');
    inbox.post('and update the changelog');
    expect(inbox.pending).toBe(2);

    expect(inbox.drain()).toEqual(['also add tests', 'and update the changelog']);
    expect(inbox.pending).toBe(0);
    expect(inbox.drain()).toEqual([]);
  });

  it('ignores blank input — a bare Enter mid-run is not a steering message', () => {
    const inbox = createSteeringInbox();
    inbox.post('   ');
    inbox.post('\n');
    inbox.post('');
    expect(inbox.pending).toBe(0);
  });

  it('trims, so the echoed text and the injected text match', () => {
    const inbox = createSteeringInbox();
    inbox.post('  use tabs  ');
    expect(inbox.drain()).toEqual(['use tabs']);
  });
});

describe('formatSteering', () => {
  it('tells the model to keep going rather than restart', () => {
    const text = formatSteering(['use tabs']);
    expect(text).toContain('while you were working');
    expect(text).toContain('keep going');
    expect(text).toContain('Do not restart');
    expect(text).toContain('use tabs');
  });

  it('bullets multiple messages so they read as separate amendments', () => {
    const text = formatSteering(['use tabs', 'skip the README']);
    expect(text).toContain('- use tabs');
    expect(text).toContain('- skip the README');
  });

  it('leaves a single message unbulleted', () => {
    expect(formatSteering(['use tabs'])).not.toContain('- use tabs');
  });
});

/** Emits queued responses, and runs a hook before each turn so a test can post
 *  steering at a precise point in the run — the way a keystroke would. */
class SteerableProvider implements LLMProvider {
  name = 'Fake';
  model = 'fake-model';
  supportsTools = true;
  /** History as the provider saw it, one snapshot per turn. */
  seen: HistoryMessage[][] = [];
  private turn = 0;

  constructor(
    private responses: LLMResponse[],
    private beforeTurn: (turn: number) => void = () => {},
  ) {}

  async complete(): Promise<LLMResponse> {
    return { text: '', toolCalls: [], stopReason: 'done' };
  }

  async *stream(_system: string, history: HistoryMessage[]): AsyncGenerator<StreamChunk> {
    this.seen.push(structuredClone(history));
    const next = this.responses.shift();
    if (!next) throw new Error('No more responses queued');
    if (next.text) yield { type: 'text', text: next.text };
    for (const tc of next.toolCalls) {
      yield { type: 'tool_start', name: tc.name, id: tc.id };
      yield { type: 'tool_end', call: tc };
    }
    yield { type: 'done', response: next };
    this.beforeTurn(++this.turn);
  }
}

describe('runAgentLoop with mid-run steering', () => {
  let tmpDir: string;
  const setup = () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-steer-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
    return tmpDir;
  };

  it('reaches the model on the turn after it was typed, without restarting the run', async () => {
    const dir = setup();
    const inbox = createSteeringInbox();
    // Typed while turn 1 was in flight.
    const provider = new SteerableProvider(
      [
        {
          text: '',
          toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'package.json' } }],
          stopReason: 'tools',
        },
        { text: 'done', toolCalls: [], stopReason: 'done' },
      ],
      turn => { if (turn === 1) inbox.post('use tabs, not spaces'); },
    );

    const ctx = await loadProjectContext(dir);
    const result = await runAgentLoop({
      provider, task: 'format the file', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      steering: inbox,
    });

    expect(result.success).toBe(true);
    // Turn 1 saw only the task. Turn 2 saw the steering appended.
    const turn1 = provider.seen[0];
    const turn2 = provider.seen[1];
    expect(turn1.some(m => m.role === 'user' && m.content.includes('use tabs'))).toBe(false);

    const steered = turn2.filter(m => m.role === 'user' && m.content.includes('use tabs, not spaces'));
    expect(steered).toHaveLength(1);
    // The original task is still the anchor — steering amends, it doesn't replace.
    expect(turn2[0]).toMatchObject({ role: 'user' });
    expect((turn2[0] as { content: string }).content).toContain('format the file');
    // And it lands after the tool result, not before it: the loop injects at
    // the turn boundary so no tool_use block is left without its result.
    const steerIdx = turn2.findIndex(m => m.role === 'user' && m.content.includes('use tabs'));
    const resultIdx = turn2.findIndex(m => m.role === 'tool_result');
    expect(resultIdx).toBeGreaterThan(-1);
    expect(steerIdx).toBeGreaterThan(resultIdx);

    fs.rmSync(dir, { recursive: true });
  });

  it('coalesces several messages typed during one turn into a single user turn', async () => {
    const dir = setup();
    const inbox = createSteeringInbox();
    const provider = new SteerableProvider(
      [
        {
          text: '',
          toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'package.json' } }],
          stopReason: 'tools',
        },
        { text: 'done', toolCalls: [], stopReason: 'done' },
      ],
      turn => {
        if (turn === 1) { inbox.post('use tabs'); inbox.post('skip the README'); }
      },
    );

    const ctx = await loadProjectContext(dir);
    await runAgentLoop({
      provider, task: 'format the file', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      steering: inbox,
    });

    const injected = provider.seen[1].filter(
      m => m.role === 'user' && m.content.includes('use tabs'),
    );
    expect(injected).toHaveLength(1);
    expect((injected[0] as { content: string }).content).toContain('skip the README');
    fs.rmSync(dir, { recursive: true });
  });

  it('is a no-op when nothing was typed — history is untouched', async () => {
    const dir = setup();
    const inbox = createSteeringInbox();
    const provider = new SteerableProvider([
      {
        text: '',
        toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'package.json' } }],
        stopReason: 'tools',
      },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);

    const ctx = await loadProjectContext(dir);
    const withSteering = await runAgentLoop({
      provider, task: 'format the file', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      steering: inbox,
    });

    expect(withSteering.success).toBe(true);
    expect(withSteering.history.filter(m => m.role === 'user')).toHaveLength(1);
    fs.rmSync(dir, { recursive: true });
  });

  it('drains the inbox, so one message is never injected twice', async () => {
    const dir = setup();
    const inbox = createSteeringInbox();
    const provider = new SteerableProvider(
      [
        { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'package.json' } }], stopReason: 'tools' },
        { text: '', toolCalls: [{ id: 'c2', name: 'read_file', input: { path: 'package.json' } }], stopReason: 'tools' },
        { text: 'done', toolCalls: [], stopReason: 'done' },
      ],
      turn => { if (turn === 1) inbox.post('use tabs'); },
    );

    const ctx = await loadProjectContext(dir);
    const result = await runAgentLoop({
      provider, task: 'format the file', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      steering: inbox,
    });

    const injected = result.history.filter(
      m => m.role === 'user' && m.content.includes('use tabs'),
    );
    expect(injected).toHaveLength(1);
    expect(inbox.pending).toBe(0);
    fs.rmSync(dir, { recursive: true });
  });
});
