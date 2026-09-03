import { describe, it, expect } from 'vitest';
import {
  looksPromissory,
  looksLikeUnparsedToolCall,
  claimedNewFiles,
  claimsVerification,
} from '../../src/agent/promise-guard.js';

/**
 * The strings below marked "observed" are verbatim from a real session that
 * ended "1 turn · 0 tool call" three times in a row while the user typed
 * "make it now" and then "finish fast". They are the regression cases.
 *
 * The negatives matter at least as much: this guard costs an extra model turn
 * and re-runs the task, so a false positive on a legitimate answer is worse
 * than the bug it fixes. Anything that reports finished work, answers a
 * question, or asks one must NOT match.
 */

describe('looksPromissory — the failure it was built for', () => {
  it('catches the observed replies', () => {
    for (const s of [
      'Adding your 7 feature cards now — one quick edit.',
      'Building your 7 feature cards now.',
      'Adding your 7 feature cards to the hyperframe now.',
      'Checking if your Aura Pulse site is already live on Vercel — pulling the repo and deployment status now.',
    ]) {
      expect(looksPromissory(s), s).toBe(true);
    }
  });

  it('catches first-person commitments to act next', () => {
    for (const s of [
      "I'll add the cards now.",
      'I will update the config.',
      'Let me read the file first.',
      "I'm going to refactor that.",
      'One moment.',
    ]) {
      expect(looksPromissory(s), s).toBe(true);
    }
  });
});

describe('looksPromissory — what it must never flag', () => {
  it('does not flag a report of completed work', () => {
    for (const s of [
      'Added the 7 feature cards to index.html and verified they render.',
      'Updated the config. Checking it now confirmed the value is applied.',
      'Fixed the off-by-one in utils.ts:42.',
      'Ran the tests: 2013 passed, 0 failed.',
    ]) {
      expect(looksPromissory(s), s).toBe(false);
    }
  });

  it('does not flag a question back to the user', () => {
    expect(looksPromissory('Which of the two config files should I be editing?')).toBe(false);
  });

  it('does not flag an explanatory answer', () => {
    // Explaining IS the work for a question; there is nothing deferred here.
    const answer = 'The cache misses on restart because the key includes the process id, '
      + 'so every boot generates a fresh namespace and nothing written by the previous run '
      + 'is ever read back. The fix is to derive the key from the project root instead.';
    expect(looksPromissory(answer)).toBe(false);
  });

  it('does not flag a long reply, however it opens', () => {
    // Length is the cheap proxy for "this reply is doing something".
    expect(looksPromissory('Checking the repo now. ' + 'x'.repeat(650))).toBe(false);
  });

  it('does not flag empty or whitespace text', () => {
    expect(looksPromissory('')).toBe(false);
    expect(looksPromissory('   \n ')).toBe(false);
  });
});

describe('looksLikeUnparsedToolCall — tool call leaked as text', () => {
  it('catches the observed Termux transcript form and its siblings', () => {
    for (const s of [
      `Let me try one more thing:\n<|toolcallstart|>[runshell(command='echo "test" > /tmp/test.txt')]<|toolcall_end|>`,
      'ok <|tool_call_begin|>{"name":"read_file"}<|tool_call_end|>',
      'I will check.\n<|tool▁call▁end|>',
      '<tool_call>\n{"name": "write_file", "arguments": {"path": "x.ts"}}\n</tool_call>',
      '[TOOL_CALLS] [run_shell(command="ls")]',
      'here goes <|python_tag|>print(1)',
    ]) {
      expect(looksLikeUnparsedToolCall(s), s).toBe(true);
    }
  });

  it('does not flag ordinary prose that mentions tools or calls', () => {
    for (const s of [
      'I called write_file with the new content and it succeeded.',
      'The tool call returned an error, so I read the file first.',
      'This function calls `execTool()` internally.',
      '',
      'See the <details> block below for the full diff.',
    ]) {
      expect(looksLikeUnparsedToolCall(s), s).toBe(false);
    }
  });
});

describe('claimedNewFiles — paths a reply says it created', () => {
  it('pulls backticked paths near a creation verb', () => {
    expect(claimedNewFiles('I created `src/foo/bar.ts` with the implementation.'))
      .toEqual(['src/foo/bar.ts']);
    expect(claimedNewFiles('New file: `scripts/deploy.sh`').sort())
      .toEqual(['scripts/deploy.sh']);
    expect(claimedNewFiles('Wrote `a.py` and generated `b/c.json` for you.').sort())
      .toEqual(['a.py', 'b/c.json']);
  });

  it('ignores non-paths and prose without a claim', () => {
    expect(claimedNewFiles('I updated the existing `config` value.')).toEqual([]);
    expect(claimedNewFiles('The bug is in `parser.ts` where it uses `==`.')).toEqual([]);
    expect(claimedNewFiles('Created a helper function to handle retries.')).toEqual([]);
  });
});

describe('claimsVerification — "the tests pass"', () => {
  it('flags assertions that verification passed', () => {
    for (const s of [
      'All tests pass.',
      'The build succeeds with no errors.',
      'I ran the tests and everything is green.',
      'Typecheck is clean.',
      'Verified the build compiles.',
    ]) {
      expect(claimsVerification(s), s).toBe(true);
    }
  });

  it('does not flag mentions that stop short of a pass claim', () => {
    for (const s of [
      'You should run the tests after this change.',
      'The test file is at tests/foo.test.ts.',
      'This might break the build — check it.',
    ]) {
      expect(claimsVerification(s), s).toBe(false);
    }
  });
});
