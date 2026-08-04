import { describe, it, expect } from 'vitest';
import { detectFrustration } from '../src/agent/affect.js';
import type { HistoryMessage } from '../src/providers/types.js';

const user = (content: string): HistoryMessage => ({ role: 'user', content });
const assistant = (content: string): HistoryMessage => ({ role: 'assistant', content });

describe('detectFrustration', () => {
  it('returns null for neutral messages', () => {
    expect(detectFrustration([user('add a logout button'), user('now make it blue')])).toBeNull();
  });

  it('returns a hint when the last user message has a frustration signal', () => {
    const hint = detectFrustration([user('add a button'), user('this is still broken')]);
    expect(hint).toMatch(/frustration/);
  });

  it('returns a hint on accumulated signals across recent messages', () => {
    const hint = detectFrustration([
      user('the build fails'),
      assistant('fixed it'),
      user('ok next feature please'),
      user("it doesn't work and the bug is back"),
    ]);
    expect(hint).toMatch(/frustration/);
  });

  it('scans only user messages', () => {
    const hint = detectFrustration([
      user('add a feature'),
      assistant('this is broken and fails and wrong'),
      user('thanks, looks good'),
    ]);
    expect(hint).toBeNull();
  });

  it('returns null for empty history', () => {
    expect(detectFrustration([])).toBeNull();
  });
});
