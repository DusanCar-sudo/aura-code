import { describe, it, expect, vi } from 'vitest';
import { RateLimiter, TpmTracker, rpmLimiter } from '../src/util/rate-limiter.js';

describe('RateLimiter', () => {
  it('allows instant acquire when tokens are available', async () => {
    const rl = new RateLimiter({ capacity: 5, refillPerMs: 0, sleep: () => Promise.resolve() });
    const wait = await rl.acquire(3);
    expect(wait).toBe(0);
    expect(rl.available()).toBeLessThanOrEqual(2);
  });

  it('waits when bucket is empty', async () => {
    const sleeps: number[] = [];
    const rl = new RateLimiter({
      capacity: 1, refillPerMs: 0.001,  // 1 token per second
      sleep: (ms) => { sleeps.push(ms); return new Promise(r => setTimeout(r, ms)); },
    });
    await rl.acquire(1);  // bucket empty now
    const waited = await rl.acquire(1);  // must wait ~1005ms
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(waited).toBeGreaterThanOrEqual(100);
  });

  it('refills over time', async () => {
    const rl = new RateLimiter({ capacity: 10, refillPerMs: 10 });  // 10 tokens/ms
    expect(rl.available()).toBe(10);
    rl.recordUsage(10);
    expect(rl.available()).toBe(0);
    // Wait a bit, tokens should refill
    await new Promise(r => setTimeout(r, 50));
    expect(rl.available()).toBe(10);
  });

  it('rejects acquiring more than capacity', async () => {
    const rl = new RateLimiter({ capacity: 5, refillPerMs: 0 });
    await expect(rl.acquire(10)).rejects.toThrow(/capacity/);
  });

  it('tryAcquire returns false when empty', () => {
    const rl = new RateLimiter({ capacity: 2, refillPerMs: 0 });
    expect(rl.tryAcquire(2)).toBe(true);
    expect(rl.tryAcquire(1)).toBe(false);
  });
});

describe('rpmLimiter', () => {
  it('creates a working limiter from rpm', () => {
    const rl = rpmLimiter(60);  // 1 req/sec
    expect(rl.available()).toBeGreaterThan(0);
  });

  it('invokes onWait callback when waiting', async () => {
    const waits: { needed: number; waitMs: number }[] = [];
    const rl = rpmLimiter(60, { burst: 1, onWait: (w) => waits.push(w) });
    await rl.acquire(1);  // consume burst
    await rl.acquire(1);  // must wait
    expect(waits.length).toBe(1);
  });
});

describe('TpmTracker', () => {
  it('tracks usage within a sliding window', () => {
    const t = new TpmTracker(1000, 1000);
    t.record(100);
    t.record(200);
    expect(t.used()).toBe(300);
    expect(t.remaining()).toBe(700);
  });

  it('expires old entries outside the window', async () => {
    const t = new TpmTracker(1000, 50);
    t.record(500, 0);
    expect(t.used(0)).toBe(500);
    expect(t.used(100)).toBe(0);  // 100ms > 50ms window
  });

  it('reports room-for-n correctly', () => {
    const t = new TpmTracker(1000);
    t.record(800);
    expect(t.hasRoomFor(200)).toBe(true);
    expect(t.hasRoomFor(201)).toBe(false);
  });

  it('suggests wait time when no room', () => {
    const t = new TpmTracker(1000, 1000);
    t.record(800, 0);
    const wait = t.waitMsFor(300, 0);  // need 300, but only 200 remain
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1000);
  });
});
