import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMixtureOfAgents } from '../src/agent/mixture.js';
import { loadProjectContext } from '../src/agent/context.js';
import type {
  LLMProvider, HistoryMessage, ToolDefinition, StreamChunk, LLMResponse,
} from '../src/providers/types.js';
import type { Display } from '../src/cli/display.js';

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

/**
 * Perspectives run in parallel, so a shared shift()-queue provider would be
 * racy. This stub answers every stream() with a fixed report and complete()
 * with a fixed synthesis, regardless of interleaving.
 */
class StubProvider implements LLMProvider {
  name = 'Stub';
  model = 'stub-model';
  supportsTools = true;
  streamCalls = 0;
  completeCalls = 0;
  completeSystem = '';
  completeContent = '';
  failStreams: boolean;

  constructor(failStreams = false) { this.failStreams = failStreams; }

  async complete(system: string, history: HistoryMessage[]): Promise<LLMResponse> {
    this.completeCalls++;
    this.completeSystem = system;
    const first = history[0];
    this.completeContent = typeof first?.content === 'string' ? first.content : '';
    return { text: 'merged answer', toolCalls: [], stopReason: 'done' };
  }

  async *stream(): AsyncGenerator<StreamChunk> {
    this.streamCalls++;
    if (this.failStreams) throw new Error('provider down');
    const response: LLMResponse = { text: 'perspective report', toolCalls: [], stopReason: 'done' };
    yield { type: 'text', text: response.text };
    yield { type: 'done', response };
  }
}

describe('runMixtureOfAgents', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-moa-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('fans out per matched domain plus a generalist, then synthesizes', async () => {
    const provider = new StubProvider();
    const ctx = await loadProjectContext(tmpDir);
    const result = await runMixtureOfAgents({
      provider,
      task: 'investigate why does the unit test for the auth token fail',
      context: ctx,
      display: noopDisplay,
    });
    expect(result.success).toBe(true);
    expect(result.summary).toBe('merged answer');
    // 2 domains (security + testing) + generalist = 3 perspectives
    expect(provider.streamCalls).toBe(3);
    expect(provider.completeCalls).toBe(1);
    // Synthesis sees the original task and every specialist report
    expect(provider.completeContent).toContain('Original task:');
    expect(provider.completeContent).toContain('perspective report');
    // 3 one-turn perspective runs + 1 synthesis call
    expect(result.turns).toBe(4);
  });

  it('falls back to generic lenses when no domain matches', async () => {
    const provider = new StubProvider();
    const ctx = await loadProjectContext(tmpDir);
    const result = await runMixtureOfAgents({
      provider,
      task: 'explain how it works',
      context: ctx,
      display: noopDisplay,
    });
    expect(result.success).toBe(true);
    expect(provider.streamCalls).toBe(2); // architecture + generalist
  });

  it('fails without a synthesis call when every perspective fails', async () => {
    const provider = new StubProvider(true);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runMixtureOfAgents({
      provider,
      task: 'explain how it works',
      context: ctx,
      display: noopDisplay,
    });
    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/perspectives failed/);
    expect(provider.completeCalls).toBe(0);
  });
});
