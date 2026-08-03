import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSystemMemoryStats, checkSystemMemory, formatMemoryStats } from '../../src/util/system-memory.js';

describe('system memory', () => {
  beforeEach(() => {
    delete process.env.MEMORY_THRESHOLD_PERCENT;
  });

  it('getSystemMemoryStats returns numeric fields on Linux-like fallback', () => {
    const stats = getSystemMemoryStats();
    expect(typeof stats.totalRam).toBe('number');
    expect(typeof stats.freeRam).toBe('number');
    expect(typeof stats.usagePercent).toBe('number');
    expect(typeof stats.availableMemory).toBe('number');
    expect(typeof stats.swapTotal).toBe('number');
    expect(typeof stats.swapUsed).toBe('number');
  });

  it('checkSystemMemory returns a recommendation and message', () => {
    const result = checkSystemMemory();
    expect(['continue', 'throttle', 'abort']).toContain(result.recommendation);
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
    expect(typeof result.underStress).toBe('boolean');
    expect(['ok', 'warn', 'critical']).toContain(result.severity);
  });

  it('formatMemoryStats returns a non-empty string', () => {
    const stats = getSystemMemoryStats();
    const text = formatMemoryStats(stats);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('Memory:');
  });

  it('respects MEMORY_THRESHOLD_PERCENT env var', () => {
    process.env.MEMORY_THRESHOLD_PERCENT = '50';
    const result = checkSystemMemory();
    expect(result.underStress).toBe(result.stats.usagePercent >= 50);
  });
});
