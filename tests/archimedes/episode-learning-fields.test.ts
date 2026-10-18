import { describe, expect, it } from 'vitest';
import { episodeLearningFields } from '../../src/archimedes/alternator.js';
import type { LoopResult } from '../../src/agent/loop.js';

function loopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    success: true,
    summary: 'done',
    turns: 1,
    toolCallCount: 2,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    costUsd: 0,
    history: [],
    toolCallLog: [],
    ...overrides,
  };
}

describe('episodeLearningFields', () => {
  it('collects edited files, test outcome and reviewer reason', async () => {
    const fields = await episodeLearningFields(
      loopResult({
        success: false,
        toolCallLog: [
          { name: 'edit_file', input: { path: 'src/b.ts' } },
          { name: 'write_file', input: { path: 'src/a.ts' } },
          { name: 'edit_file', input: { path: 'src/b.ts' } },
          { name: 'run_tests', input: {} },
        ],
      }),
      '/tmp/not-a-repo-anywhere-else',
      'claim unsupported',
    );
    expect(fields.filesTouched).toEqual(['src/a.ts', 'src/b.ts']);
    expect(fields.testResult).toBe('fail');
    expect(fields.reviewerReason).toBe('claim unsupported');
  });

  it('reports no test result when tests never ran, and no diff outside a git repo', async () => {
    const fields = await episodeLearningFields(
      loopResult({ toolCallLog: [{ name: 'read_file', input: { path: 'x' } }] }),
      '/tmp/definitely-not-a-git-repo',
      undefined,
    );
    expect(fields.testResult).toBeUndefined();
    expect(fields.filesTouched).toBeUndefined();
    expect(fields.diff).toBeUndefined();
    expect(fields.reviewerReason).toBeUndefined();
  });

  it('returns only reviewerReason when there is no loop result', async () => {
    const fields = await episodeLearningFields(undefined, '/tmp/x', 'why');
    expect(fields).toEqual({ reviewerReason: 'why' });
  });
});
