import { describe, it, expect } from 'vitest';

import { isAffirmative, PermissionSystem } from '../../src/safety/permissions.js';

/**
 * The prompt defaults to yes, which is right for an agent session — but the
 * interesting property is not what approves, it is what does *not*. Written the
 * obvious way, a default-yes prompt reads "anything that isn't 'no' is a yes",
 * and then the failure mode of the safety prompt is *allow*: a typo, a stray
 * keystroke, a pasted line, or a hesitating "wait" all authorise the write.
 *
 * These pin the boundary in the safe direction — unrecognised input costs a
 * re-prompt, never an unwanted operation.
 */

describe('confirm() answer parsing', () => {
  it('approves on Enter — that is the point of [Y/n]', () => {
    expect(isAffirmative('')).toBe(true);
    expect(isAffirmative('   ')).toBe(true);
  });

  it('approves an explicit yes, in any casing, with stray whitespace', () => {
    for (const a of ['y', 'Y', 'yes', 'YES', ' Yes ', 'ok', 'OK']) {
      expect(isAffirmative(a), a).toBe(true);
    }
  });

  it('declines an explicit no', () => {
    for (const a of ['n', 'N', 'no', 'NO', ' No ']) {
      expect(isAffirmative(a), a).toBe(false);
    }
  });

  it('declines anything it does not understand, rather than assuming yes', () => {
    // Each of these authorised the operation under the "not no" rule.
    for (const a of ['wait', 'hmm', 'y es', 'stop', 'q', 'ye', 'yy', '?', 'sure',
                     'git status', 'nope not that one']) {
      expect(isAffirmative(a), a).toBe(false);
    }
  });
});

describe('PermissionSystem default level', () => {
  it('defaults to auto — no per-operation prompt for ordinary work', () => {
    expect(new PermissionSystem().getLevel()).toBe('auto');
  });

  it('still blocks dangerous shell commands in auto', () => {
    // "auto" removes the prompt; it does not remove the blocklist. If this ever
    // goes green-to-red, auto has become genuinely unguarded.
    const p = new PermissionSystem();
    const verdict = p.check('run_shell', { command: 'rm -rf /' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/dangerous/i);
  });

  it('honours an explicit level over the default', () => {
    expect(new PermissionSystem('read-only').getLevel()).toBe('read-only');
    expect(new PermissionSystem('normal').getLevel()).toBe('normal');
  });
});
