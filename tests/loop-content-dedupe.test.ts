import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Same rationale as loop.test.ts: pin the summary provider so the tiered-context
// path can never reach the network from a test.
vi.mock('../src/providers/factory.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/providers/factory.js')>();
  return {
    ...mod,
    createProvider: () => ({
      name: 'stub-summary-provider',
      model: 'stub',
      supportsTools: false,
      complete: async () => ({ text: '- stub fact', toolCalls: [], stopReason: 'done' as const }),
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done', response: { text: '', toolCalls: [], stopReason: 'done' } };
      },
    }),
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dns from 'dns';
import { runAgentLoop } from '../src/agent/loop.js';
import { PermissionSystem } from '../src/safety/permissions.js';
import { loadProjectContext } from '../src/agent/context.js';
import type {
  LLMProvider, HistoryMessage, StreamChunk, LLMResponse,
} from '../src/providers/types.js';
import type { Display } from '../src/cli/display.js';

/**
 * The regression this guards: an agent asked to copy a site's theme fetched
 * /style.css, /index.css, / at two different max_chars, and / with explicit
 * headers — five distinct URLs. The host was a static deploy, which answers
 * every unmatched path with index.html and HTTP 200, so all five returned
 * byte-identical HTML with a success status. Nothing caught it:
 *
 *   - the redundant-read cache keys on the call signature, and five different
 *     inputs are five different keys, so every call missed;
 *   - web_fetch is deliberately excluded from that cache anyway (it is
 *     non-deterministic — a fetch must never be served stale);
 *   - stall detection compares *calls*, not *results*, so it only fired once the
 *     calls themselves repeated verbatim, several turns later.
 *
 * Meanwhile each identical payload was re-injected into context at full size.
 * The fix detects identical content across differing inputs and says so, without
 * suppressing the call or serving anything from cache.
 */

const noopDisplay: Display = {
  agentThinking: () => {}, streamText: () => {}, streamEnd: () => {},
  toolStart: () => {}, toolCall: () => {}, toolResult: () => {},
  toolBlocked: () => {}, warning: () => {}, success: () => {}, error: () => {},
  header: () => {}, summary: () => {},
};

class FakeProvider implements LLMProvider {
  name = 'Fake';
  model = 'fake-model';
  supportsTools = true;
  responses: LLMResponse[];
  completeText = '- distilled fact';
  constructor(responses: LLMResponse[]) { this.responses = responses; }
  async complete(): Promise<LLMResponse> {
    return { text: this.completeText, toolCalls: [], stopReason: 'done' };
  }
  async *stream(): AsyncGenerator<StreamChunk> {
    const next = this.responses.shift();
    if (!next) throw new Error('No more responses queued');
    if (next.text) yield { type: 'text', text: next.text };
    for (const tc of next.toolCalls) {
      yield { type: 'tool_start', name: tc.name, id: tc.id };
      yield { type: 'tool_end', call: tc };
    }
    yield { type: 'done', response: next };
  }
}

/** Every tool_result content string in history, flattened. */
function resultTexts(history: HistoryMessage[]): string[] {
  return history
    .filter((m): m is HistoryMessage & { results: { content: string }[] } => m.role === 'tool_result')
    .flatMap(m => m.results.map(r => r.content));
}

describe('identical fetch content across different inputs', () => {
  let tmpDir: string;
  const mockFetch = vi.fn();
  const SPA = '<html><body><h1>Landing</h1><p>Same bytes every time.</p></body></html>';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-dedupe-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
    vi.stubEnv('AURA_CONTEXT_STRATEGY', '');
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const html = () => new Response(SPA, { headers: new Headers({ 'content-type': 'text/html' }) });

  it('flags the second URL that returns byte-identical content', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(html()));
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'a', name: 'web_fetch', input: { url: 'https://example.com/' } }], stopReason: 'tool_use' },
      { text: '', toolCalls: [{ id: 'b', name: 'web_fetch', input: { url: 'https://example.com/style.css' } }], stopReason: 'tool_use' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'copy the theme', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });

    const texts = resultTexts(result.history);
    expect(texts).toHaveLength(2);
    // First call: nothing to compare against yet.
    expect(texts[0]).not.toContain('identical to the earlier');
    // Second: same bytes from a different URL, so it is named.
    expect(texts[1]).toContain('identical to the earlier');
    expect(texts[1]).toContain('web_fetch(url="https://example.com/")');
    expect(texts[1]).toContain('Change approach');
  });

  it('still executes the call — this is detection, not caching', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(html()));
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'a', name: 'web_fetch', input: { url: 'https://example.com/a' } }], stopReason: 'tool_use' },
      { text: '', toolCalls: [{ id: 'b', name: 'web_fetch', input: { url: 'https://example.com/b' } }], stopReason: 'tool_use' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'x', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });

    // Both fetches really went out; a cache hit would have skipped the second.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // And the fresh body is still present, not replaced by the note.
    expect(resultTexts(result.history)[1]).toContain('Landing');
  });

  it('does not flag a repeat of the very same input', async () => {
    // Identical input is the signature cache's and stall detection's job; this
    // check is only for *different* inputs converging on one result.
    mockFetch.mockImplementation(() => Promise.resolve(html()));
    const url = 'https://example.com/same';
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'a', name: 'web_fetch', input: { url } }], stopReason: 'tool_use' },
      { text: '', toolCalls: [{ id: 'b', name: 'web_fetch', input: { url } }], stopReason: 'tool_use' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'x', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    for (const t of resultTexts(result.history)) {
      expect(t).not.toContain('identical to the earlier');
    }
  });

  it('ignores the metadata preamble, which echoes the differing URL', async () => {
    // The subtle part. web_fetch prints `URL: <url>` in its header block, so two
    // fetches of one page are never byte-identical as whole strings — hashing the
    // full result would miss every case this check exists for. Here the .css
    // request also acquires a mismatch WARNING in that same block, and the match
    // must still be found on the body alone.
    mockFetch.mockImplementation(() => Promise.resolve(html()));
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'a', name: 'web_fetch', input: { url: 'https://example.com/' } }], stopReason: 'tool_use' },
      { text: '', toolCalls: [{ id: 'b', name: 'web_fetch', input: { url: 'https://example.com/theme.css' } }], stopReason: 'tool_use' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'x', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    const texts = resultTexts(result.history);
    // Preambles genuinely differ...
    expect(texts[0]).toContain('URL: https://example.com/');
    expect(texts[1]).toContain('URL: https://example.com/theme.css');
    expect(texts[1]).toContain('WARNING: requested .css');
    // ...and the identical body is still recognised.
    expect(texts[1]).toContain('identical to the earlier');
  });

  it('leaves genuinely different content unflagged', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('<html><body>page one</body></html>', { headers: new Headers({ 'content-type': 'text/html' }) }))
      .mockResolvedValueOnce(new Response('<html><body>page two</body></html>', { headers: new Headers({ 'content-type': 'text/html' }) }));
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'a', name: 'web_fetch', input: { url: 'https://example.com/one' } }], stopReason: 'tool_use' },
      { text: '', toolCalls: [{ id: 'b', name: 'web_fetch', input: { url: 'https://example.com/two' } }], stopReason: 'tool_use' },
      { text: 'done', toolCalls: [], stopReason: 'done' },
    ]);
    const ctx = await loadProjectContext(tmpDir);
    const result = await runAgentLoop({
      provider, task: 'x', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
    });
    for (const t of resultTexts(result.history)) {
      expect(t).not.toContain('identical to the earlier');
    }
  });
});
