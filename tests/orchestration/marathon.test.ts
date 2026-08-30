import { afterEach, describe, expect, it } from 'vitest';

import {
  MARATHON_DURATION_MS,
  MarathonManager,
  formatRemaining,
} from '../../src/orchestration/marathon.js';

afterEach(() => MarathonManager.reset());

describe('marathon mode', () => {
  it('starts off', () => {
    expect(MarathonManager.isActive()).toBe(false);
    expect(MarathonManager.getState().enabled).toBe(false);
  });

  it('turns on and reports the time it has left', () => {
    MarathonManager.activate();
    const st = MarathonManager.getState();
    expect(st.enabled).toBe(true);
    expect(st.activatedAt).not.toBeNull();
    // Within a second of a full day — the clock moved between the two calls.
    expect(st.remainingMs).toBeGreaterThan(MARATHON_DURATION_MS - 1000);
    expect(st.remainingMs).toBeLessThanOrEqual(MARATHON_DURATION_MS);
  });

  it('lapses on its own after the duration', () => {
    MarathonManager.activate();
    const start = Date.now();
    expect(MarathonManager.isActive(start + MARATHON_DURATION_MS - 1)).toBe(true);
    // The boundary is exclusive: at exactly the expiry it is over.
    expect(MarathonManager.isActive(start + MARATHON_DURATION_MS)).toBe(false);
  });

  it('reports off once lapsed, rather than a stale enabled state', () => {
    // The bug this guards: reading `enabled` straight off stored state would
    // keep saying yes forever, since nothing clears it on a timer.
    MarathonManager.activate(50);
    const later = Date.now() + 10_000;
    expect(MarathonManager.getState(later)).toEqual({
      enabled: false,
      activatedAt: null,
      expiresAt: null,
      remainingMs: 0,
    });
  });

  it('restarts the clock when activated again', () => {
    MarathonManager.activate();
    const first = MarathonManager.getState().activatedAt as number;
    MarathonManager.activate();
    expect(MarathonManager.getState().activatedAt as number).toBeGreaterThanOrEqual(first);
  });

  it('turns off on demand', () => {
    MarathonManager.activate();
    MarathonManager.deactivate();
    expect(MarathonManager.isActive()).toBe(false);
  });

  it('falls back to the default for a non-positive duration', () => {
    MarathonManager.activate(0);
    expect(MarathonManager.getState().remainingMs).toBeGreaterThan(MARATHON_DURATION_MS - 1000);
  });
});

describe('formatRemaining', () => {
  it('renders hours and minutes', () => {
    expect(formatRemaining(23 * 3_600_000 + 41 * 60_000)).toBe('23h 41m');
  });

  it('drops the hours when there are none', () => {
    expect(formatRemaining(7 * 60_000)).toBe('7m');
  });

  it('does not render "0m" for a live marathon', () => {
    expect(formatRemaining(30_000)).toBe('under a minute');
  });

  it('says expired at or below zero', () => {
    expect(formatRemaining(0)).toBe('expired');
    expect(formatRemaining(-1)).toBe('expired');
  });
});
