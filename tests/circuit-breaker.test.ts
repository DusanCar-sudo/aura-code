import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../src/util/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(0);
  });

  it('closes on success', async () => {
    const cb = new CircuitBreaker();
    const out = await cb.call(async () => 'ok');
    expect(out).toBe('ok');
    expect(cb.getState()).toBe('closed');
  });

  it('opens after N consecutive failures', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    }
    expect(cb.getState()).toBe('open');
  });

  it('throws CircuitOpenError when open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    await expect(cb.call(async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(cb.call(async () => 'never-called')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('transitions to half-open after cooldown', async () => {
    const states: string[] = [];
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10,
      onStateChange: (s) => states.push(s),
    });
    await expect(cb.call(async () => { throw new Error('x'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');
    await new Promise(r => setTimeout(r, 20));
    const result = await cb.call(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(states).toContain('half-open');
    expect(states[states.length - 1]).toBe('closed');
  });

  it('re-opens on half-open failure', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10 });
    await expect(cb.call(async () => { throw new Error('x'); })).rejects.toThrow();
    await new Promise(r => setTimeout(r, 20));
    await expect(cb.call(async () => { throw new Error('again'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');
  });

  it('resets failure count on success', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    await expect(cb.call(async () => { throw new Error('x'); })).rejects.toThrow();
    await expect(cb.call(async () => { throw new Error('x'); })).rejects.toThrow();
    expect(cb.getFailureCount()).toBe(2);
    await cb.call(async () => 'ok');
    expect(cb.getFailureCount()).toBe(0);
  });
});
