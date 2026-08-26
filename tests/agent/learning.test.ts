import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  recordLesson, loadLessons, lessonKey, recallForTask, formatRecall,
  classifyScope, globalLessonsPath, projectLessonsPath, MAX_LESSONS_PER_SCOPE,
} from '../../src/agent/learning.js';
import { loadUnifiedMemory } from '../../src/agent/unified-memory.js';

let home: string;
let proj: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-learn-home-'));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-learn-proj-'));
  vi.stubEnv('AURA_HOME', home);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('the lesson store', () => {
  it('writes a global lesson where the prompt already looks for it', () => {
    expect(recordLesson('Zhipu coding plan needs a zhipu-coding/ model prefix', 'global')).toBe(true);
    expect(fs.existsSync(globalLessonsPath())).toBe(true);
    expect(loadLessons('global').map(l => l.text))
      .toEqual(['Zhipu coding plan needs a zhipu-coding/ model prefix']);
  });

  it('writes a project lesson beside the project', () => {
    recordLesson('tests here need AURA_HOME stubbed', 'project', proj);
    expect(fs.existsSync(projectLessonsPath(proj))).toBe(true);
    expect(loadLessons('project', proj)).toHaveLength(1);
  });

  it('never records the same lesson twice', () => {
    const text = 'portal dialog can open behind other windows';
    expect(recordLesson(text, 'global')).toBe(true);
    expect(recordLesson(text, 'global')).toBe(false);
    expect(loadLessons('global')).toHaveLength(1);
  });

  it('dedupes on an explicit key, so a re-derived fact worded differently still counts as known', () => {
    expect(recordLesson('X is true because A', 'global', undefined, 'gap-x')).toBe(true);
    expect(recordLesson('X is true, established via B', 'global', undefined, 'gap-x')).toBe(false);
    expect(loadLessons('global')).toHaveLength(1);
  });

  it('caps the file so it cannot quietly become the largest thing in the prompt', () => {
    for (let i = 0; i < MAX_LESSONS_PER_SCOPE + 15; i++) {
      recordLesson(`fact number ${i} about something`, 'global');
    }
    const kept = loadLessons('global');
    expect(kept).toHaveLength(MAX_LESSONS_PER_SCOPE);
    // Oldest out first — the newest fact survives, the first does not.
    expect(kept.some(l => l.text.includes(`number ${MAX_LESSONS_PER_SCOPE + 14}`))).toBe(true);
    expect(kept.some(l => l.text === 'fact number 0 about something')).toBe(false);
  });

  it('survives a round trip through the markdown format', () => {
    recordLesson('a lesson with -- dashes and <brackets>', 'global');
    expect(loadLessons('global')[0].text).toBe('a lesson with -- dashes and <brackets>');
  });

  it('refuses blank text', () => {
    expect(recordLesson('   ', 'global')).toBe(false);
    expect(loadLessons('global')).toHaveLength(0);
  });

  it('cannot write a project lesson with no project', () => {
    expect(recordLesson('something', 'project', undefined)).toBe(false);
  });
});

describe('recall', () => {
  it('finds a stored lesson from an overlapping query — the free path that avoids research', () => {
    recordLesson('the pipewire portal dialog can open behind other windows', 'global');
    const hits = recallForTask('why does the portal capture seem to hang');
    expect(hits.map(h => h.text).join(' ')).toMatch(/portal dialog/);
    expect(hits[0].source).toBe('lesson/global');
  });

  it('searches both scopes at once', () => {
    recordLesson('provider ids need a vendor prefix', 'global');
    recordLesson('this repo stubs AURA_HOME in tests', 'project', proj);
    const hits = recallForTask('prefix AURA_HOME repo provider', proj);
    const sources = hits.map(h => h.source);
    expect(sources).toContain('lesson/global');
    expect(sources).toContain('lesson/project');
  });

  it('returns nothing for an unrelated query rather than the nearest bad match', () => {
    recordLesson('the portal dialog can open behind other windows', 'global');
    expect(recallForTask('sourdough hydration percentages')).toHaveLength(0);
  });

  it('ignores stopwords, so a query of only common words matches nothing', () => {
    recordLesson('something specific about widgets', 'global');
    expect(recallForTask('what does the not have for this')).toHaveLength(0);
  });

  it('formats nothing as empty string, not an empty header', () => {
    expect(formatRecall([])).toBe('');
    expect(formatRecall([{ text: 'a', source: 'lesson/global' }])).toMatch(/already learned/);
  });
});

describe('scope classification', () => {
  it('files a fact about the world as global', () => {
    expect(classifyScope('Anthropic model ids are dated, e.g. claude-opus-4-5-20251001')).toBe('global');
    expect(classifyScope('PR_SET_PDEATHSIG is Linux-only')).toBe('global');
  });

  it('files a fact naming a path or file as project-local', () => {
    expect(classifyScope('src/agent/loop.ts seeds history from initialHistory')).toBe('project');
    expect(classifyScope('the tests in this repo need a temp home')).toBe('project');
  });

  it('files a fact naming the repo itself as project-local', () => {
    expect(classifyScope('aura-code copies .py assets in postbuild', '/home/x/aura-code')).toBe('project');
  });

  it('breaks ties toward project — a mislabelled global is asserted wrongly forever', () => {
    // Mentions a filename, so it stays local even though it reads general.
    expect(classifyScope('config.yml keys are case sensitive')).toBe('project');
  });
});

describe('lesson visibility in the prompt', () => {
  it('injects a global lesson into a project session — the cross-project bug', () => {
    recordLesson('zhipu coding plan needs the zhipu-coding/ prefix', 'global');
    const block = loadUnifiedMemory({ projectRoot: proj });
    expect(block).toMatch(/zhipu-coding/);
  });

  it('injects both scopes together', () => {
    recordLesson('a global truth about providers', 'global');
    recordLesson('a local truth about this tree', 'project', proj);
    const block = loadUnifiedMemory({ projectRoot: proj });
    expect(block).toMatch(/global truth/);
    expect(block).toMatch(/local truth/);
  });

  it('adds nothing when nothing has been learned', () => {
    expect(loadUnifiedMemory({ projectRoot: proj })).not.toMatch(/Lessons from past sessions/);
  });
});

describe('lessonKey', () => {
  it('is stable for the same gap and differs for different ones', () => {
    expect(lessonKey('How does X work?')).toBe(lessonKey('how does x work'));
    expect(lessonKey('How does X work?')).not.toBe(lessonKey('how does Y work'));
  });

  it('never produces an empty key', () => {
    expect(lessonKey('!!!')).toBe('lesson');
  });
});

// ── The loop integration ────────────────────────────────────────────────────

import { runAgentLoop } from '../../src/agent/loop.js';
import { PermissionSystem } from '../../src/safety/permissions.js';
import { loadProjectContext } from '../../src/agent/context.js';
import type {
  LLMProvider, HistoryMessage, StreamChunk, LLMResponse,
} from '../../src/providers/types.js';
import type { Display } from '../../src/cli/display.js';

const noopDisplay: Display = {
  agentThinking: () => {}, streamText: () => {}, streamEnd: () => {},
  toolStart: () => {}, toolCall: () => {}, toolResult: () => {}, toolBlocked: () => {},
  warning: () => {}, success: () => {}, error: () => {}, header: () => {},
  summary: () => {}, showPlan: () => {}, stepStarted: () => {}, stepCompleted: () => {},
};

/** Streams queued responses; `complete()` answers the gap-naming call, which is
 *  deliberately a non-tool call so it can be scripted separately. */
class GapProvider implements LLMProvider {
  name = 'Fake'; model = 'fake-model'; supportsTools = true;
  completeReplies: string[] = [];
  completeCalls: string[] = [];
  constructor(private responses: LLMResponse[]) {}

  async complete(_s: string, history: HistoryMessage[]): Promise<LLMResponse> {
    const last = history[history.length - 1];
    this.completeCalls.push(last && last.role === 'user' ? last.content : '');
    return { text: this.completeReplies.shift() ?? '', toolCalls: [], stopReason: 'done' };
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

const turnCapRun = (n: number): LLMResponse[] =>
  Array.from({ length: n }, (_, i) => ({
    text: '',
    toolCalls: [{ id: `c${i}`, name: 'list_dir', input: { path: '.' } }],
    stopReason: 'tools' as const,
  }));

describe('the loop when it would have given up', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-gap-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('closes the gap from memory without spending a research run', async () => {
    recordLesson('the widget flag must be set before the handshake', 'global');

    const provider = new GapProvider([
      ...turnCapRun(2),
      // The resumed run, which now has the answer and finishes.
      { text: 'done, using the widget flag', toolCalls: [], stopReason: 'done' },
    ]);
    provider.completeReplies = ['GAP: how the widget flag works\nQUERY: widget flag handshake'];

    const ctx = await loadProjectContext(dir);
    const result = await runAgentLoop({
      provider, task: 'wire up the widget', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      maxTurns: 2,
    });

    // It finished rather than reporting a stall.
    expect(result.success).toBe(true);
    expect(result.summary).toMatch(/widget flag/);
    // The recalled lesson was handed to the resumed run.
    const resumeMsg = result.history.find(
      m => m.role === 'user' && m.content.includes('missing something'),
    );
    expect(resumeMsg).toBeDefined();
    expect((resumeMsg as { content: string }).content).toMatch(/before the handshake/);
    // Turn counts are summed across both legs, not just the resumed one.
    expect(result.turns).toBeGreaterThan(2);
  });

  it('does not fire when the user aborted — stop means stop', async () => {
    const ac = new AbortController();
    ac.abort();
    const provider = new GapProvider([{ text: 'x', toolCalls: [], stopReason: 'done' }]);
    provider.completeReplies = ['GAP: something\nQUERY: something'];

    const ctx = await loadProjectContext(dir);
    const result = await runAgentLoop({
      provider, task: 'do a thing', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      abortSignal: ac.signal,
    });

    expect(result.success).toBe(false);
    expect(provider.completeCalls).toHaveLength(0);
  });

  it('gives up honestly when the model says nothing is missing', async () => {
    const provider = new GapProvider(turnCapRun(2));
    provider.completeReplies = ['GAP: none'];

    const ctx = await loadProjectContext(dir);
    const result = await runAgentLoop({
      provider, task: 'do a thing', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      maxTurns: 2,
    });

    expect(result.success).toBe(false);
    expect(result.summary).toMatch(/Loop ended after/);
  });

  it('never recurses — the resumed run cannot start another gap pass', async () => {
    recordLesson('some relevant widget fact', 'global');
    const provider = new GapProvider([
      ...turnCapRun(1),
      ...turnCapRun(1),   // the resumed run also hits its cap
    ]);
    provider.completeReplies = ['GAP: widget\nQUERY: widget', 'GAP: widget again\nQUERY: widget'];

    const ctx = await loadProjectContext(dir);
    const result = await runAgentLoop({
      provider, task: 'widget work', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      maxTurns: 1,
    });

    expect(result.success).toBe(false);
    // Exactly one gap-naming call: the resumed run carries noGapPass.
    expect(provider.completeCalls).toHaveLength(1);
  });

  it('is skipped entirely when noGapPass is set', async () => {
    const provider = new GapProvider(turnCapRun(1));
    provider.completeReplies = ['GAP: something\nQUERY: something'];

    const ctx = await loadProjectContext(dir);
    await runAgentLoop({
      provider, task: 'do a thing', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      maxTurns: 1, noGapPass: true,
    });

    expect(provider.completeCalls).toHaveLength(0);
  });
});

describe('cost accounting across a recovery', () => {
  it('reports both legs, so the gap pass cannot hide what it spent', async () => {
    recordLesson('the widget flag must be set first', 'global');
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-gapcost-'));
    fs.writeFileSync(path.join(dir2, 'package.json'), JSON.stringify({ name: 't', scripts: {} }));

    const withUsage = (r: LLMResponse): LLMResponse =>
      ({ ...r, usage: { inputTokens: 100, outputTokens: 10 } });

    const provider = new GapProvider([
      withUsage({ text: '', toolCalls: [{ id: 'c0', name: 'list_dir', input: { path: '.' } }], stopReason: 'tools' }),
      withUsage({ text: 'done with the widget flag', toolCalls: [], stopReason: 'done' }),
    ]);
    provider.completeReplies = ['GAP: the widget flag\nQUERY: widget flag'];

    const ctx = await loadProjectContext(dir2);
    const result = await runAgentLoop({
      provider, task: 'widget work', context: ctx,
      permissions: new PermissionSystem('auto'), display: noopDisplay,
      maxTurns: 1,
    });

    expect(result.success).toBe(true);
    // Both legs billed 100 in / 10 out — a single leg's total would be half this.
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(20);
    fs.rmSync(dir2, { recursive: true, force: true });
  });
});
