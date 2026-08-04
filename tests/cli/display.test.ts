import { describe, it, expect } from 'vitest';
import { formatContextBar } from '../../src/cli/display.js';

// Strip ANSI color codes so assertions can check plain content.
function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('formatContextBar', () => {
  it('renders a normal partially-filled bar without throwing', () => {
    const out = plain(formatContextBar(50_000, 200_000, false));
    expect(out).toContain('25%');
    expect(out).toMatch(/█+░+/);
  });

  it('renders a fully-filled bar at exactly 100% without throwing', () => {
    const out = plain(formatContextBar(200_000, 200_000, false));
    expect(out).toContain('100%');
    expect(out).not.toContain('░'); // fully filled, no empty segments
  });

  it('does NOT throw when used tokens exceed the limit (the original crash case)', () => {
    // This is the exact failure mode from production: cumulative session
    // tokens (1,586,666) compared against a single model's context window
    // (e.g. 128,000) produces pct > 100%, which used to make `empty` go
    // negative and crash on '░'.repeat(negative).
    expect(() => formatContextBar(1_586_666, 128_000, false)).not.toThrow();
  });

  it('clamps the bar visual to fully-filled when usage exceeds the limit', () => {
    const out = plain(formatContextBar(1_586_666, 128_000, false));
    // Bar itself can't physically render past 100% — should be all filled blocks.
    expect(out).toMatch(/█{10}/);
    expect(out).not.toContain('░');
  });

  it('still reports the true (un-clamped) percentage in the text, even past 100%', () => {
    // Deliberately NOT clamping the displayed number — seeing "1240%" is a
    // useful signal that something is genuinely overrunning the window,
    // and hiding it behind a clamped "100%" would mask that.
    const out = plain(formatContextBar(1_586_666, 128_000, false));
    expect(out).toContain('1240%');
  });

  it('handles zero usage without throwing', () => {
    const out = plain(formatContextBar(0, 128_000, false));
    expect(out).toContain('0%');
    expect(out).toMatch(/░{10}/);
  });

  it('marks estimated usage with the (estimated) tag and distinct color path', () => {
    const out = plain(formatContextBar(10_000, 128_000, true));
    expect(out).toContain('(estimated)');
    expect(out).toContain('~');
  });

  it('does not throw for a tiny limit that usage easily exceeds', () => {
    // Guards against any future divide-by-small-number edge case alongside
    // the exceeds-limit case.
    expect(() => formatContextBar(500, 100, false)).not.toThrow();
  });
});
