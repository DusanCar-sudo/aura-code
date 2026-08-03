/**
 * System memory monitoring and guardrails.
 *
 * Tracks OS-level memory usage (RAM + swap) and provides guardrails to prevent
 * system crashes due to memory exhaustion. Aura operations can check before
 * starting memory-intensive work and throttle or abort when system is under stress.
 *
 * Default threshold: 80% memory usage triggers warnings and throttling.
 * Configurable via MEMORY_THRESHOLD_PERCENT env var (0-100, 80 = 80%).
 */

import * as os from 'os';

/** Memory usage statistics for the system. */
export interface SystemMemoryStats {
  /** Total system RAM in bytes */
  totalRam: number;
  /** Free RAM in bytes, excluding swap */
  freeRam: number;
  /** Total RAM + swap in bytes */
  totalMemory: number;
  /** Used RAM + swap in bytes */
  usedMemory: number;
  /** Free RAM + swap in bytes */
  freeMemory: number;
  /** Usage percentage (0-100) */
  usagePercent: number;
  /** Available memory in bytes (what apps can actually use) */
  availableMemory: number;
  /** Available memory percentage (0-100) */
  availablePercent: number;
  /** Swap total in bytes */
  swapTotal: number;
  /** Swap used in bytes */
  swapUsed: number;
  /** Swap usage percentage (0-100) */
  swapPercent: number;
}

/** Memory check result with recommendation. */
export interface MemoryCheckResult {
  stats: SystemMemoryStats;
  /** Whether the system is under memory stress (above threshold) */
  underStress: boolean;
  /** Severity level for UI display */
  severity: 'ok' | 'warn' | 'critical';
  /** Human-readable message describing the state */
  message: string;
  /** Recommendation for what to do (continue, throttle, abort) */
  recommendation: 'continue' | 'throttle' | 'abort';
  /** Estimated additional memory available for operations (bytes) */
  availableForWork: number;
}

/** Get the memory threshold percentage from env or default to 80%. */
function getThresholdPercent(): number {
  const env = process.env.MEMORY_THRESHOLD_PERCENT;
  if (!env) return 80;
  const parsed = Number(env);
  if (isNaN(parsed) || parsed < 0 || parsed > 100) {
    console.warn(`MEMORY_THRESHOLD_PERCENT="${env}" is invalid (0-100 required) — using default 80%`);
    return 80;
  }
  return parsed;
}

/**
 * Get current system memory statistics.
 * Combines RAM and swap into total memory metrics since both contribute to
 * system stability (swap exhaustion also causes crashes).
 */
export function getSystemMemoryStats(): SystemMemoryStats {
  const totalRam = os.totalmem();
  const freeRam = os.freemem();

  // Node.js os module doesn't provide swap directly in all environments
  // Best-effort approximation from common patterns
  const swapTotal = os.type() === 'Linux' ? parseSwapTotalFromMeminfo() : 0;
  const swapUsed = os.type() === 'Linux' ? parseSwapUsedFromMeminfo() : 0;

  const totalMemory = totalRam + swapTotal;
  const usedMemory = (totalRam - freeRam) + swapUsed;
  const freeMemory = totalMemory - usedMemory;
  const usagePercent = (usedMemory / totalMemory) * 100;
  const availableMemory = freeRam + (swapTotal - swapUsed);
  const availablePercent = (availableMemory / totalMemory) * 100;
  const swapPercent = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;

  return {
    totalRam,
    freeRam,
    totalMemory,
    usedMemory,
    freeMemory,
    usagePercent,
    availableMemory,
    availablePercent,
    swapTotal,
    swapUsed,
    swapPercent,
  };
}

/**
 * Parse swap total from /proc/meminfo on Linux.
 * Returns 0 if unavailable or not Linux.
 */
function parseSwapTotalFromMeminfo(): number {
  try {
    const fs = require('fs');
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
    const match = meminfo.match(/SwapTotal:\s+(\d+)\s+kB/);
    return match ? Number(match[1]) * 1024 : 0; // Convert kB to bytes
  } catch {
    return 0;
  }
}

/**
 * Parse swap used from /proc/meminfo on Linux.
 * Returns 0 if unavailable or not Linux.
 */
function parseSwapUsedFromMeminfo(): number {
  try {
    const fs = require('fs');
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
    const totalMatch = meminfo.match(/SwapTotal:\s+(\d+)\s+kB/);
    const freeMatch = meminfo.match(/SwapFree:\s+(\d+)\s+kB/);
    if (!totalMatch || !freeMatch) return 0;
    const total = Number(totalMatch[1]) * 1024;
    const free = Number(freeMatch[1]) * 1024;
    return total - free;
  } catch {
    return 0;
  }
}

/**
 * Check system memory and return a recommendation.
 *
 * - continue: Memory is healthy, proceed normally
 * - throttle: Memory is elevated (70-80%), consider reducing parallelism or skipping heavy operations
 * - abort: Memory is critical (80%+), strongly recommend aborting memory-intensive work
 *
 * The threshold is configurable via MEMORY_THRESHOLD_PERCENT (default 80).
 */
export function checkSystemMemory(): MemoryCheckResult {
  const stats = getSystemMemoryStats();
  const threshold = getThresholdPercent();

  let severity: 'ok' | 'warn' | 'critical';
  let message: string;
  let recommendation: 'continue' | 'throttle' | 'abort';

  if (stats.usagePercent < 70) {
    severity = 'ok';
    message = `System memory healthy (${stats.usagePercent.toFixed(1)}% used, ${(stats.availableMemory / 1024 / 1024 / 1024).toFixed(1)}GB available)`;
    recommendation = 'continue';
  } else if (stats.usagePercent < threshold) {
    severity = 'warn';
    message = `System memory elevated (${stats.usagePercent.toFixed(1)}% used, ${(stats.availableMemory / 1024 / 1024 / 1024).toFixed(1)}GB available) — consider reducing parallelism`;
    recommendation = 'throttle';
  } else {
    severity = 'critical';
    message = `System memory critical (${stats.usagePercent.toFixed(1)}% used, ${(stats.availableMemory / 1024 / 1024 / 1024).toFixed(1)}GB available) — abort memory-intensive operations`;
    recommendation = 'abort';
  }

  return {
    stats,
    underStress: stats.usagePercent >= threshold,
    severity,
    message,
    recommendation,
    availableForWork: stats.availableMemory,
  };
}

/**
 * Format memory stats for human display.
 */
export function formatMemoryStats(stats: SystemMemoryStats): string {
  const gb = 1024 * 1024 * 1024;
  const usedGB = (stats.usedMemory / gb).toFixed(1);
  const totalGB = (stats.totalMemory / gb).toFixed(1);
  const availGB = (stats.availableMemory / gb).toFixed(1);
  const swapGB = (stats.swapTotal / gb).toFixed(1);
  const swapUsedGB = (stats.swapUsed / gb).toFixed(1);

  return `Memory: ${usedGB}/${totalGB}GB (${stats.usagePercent.toFixed(1)}%) | Available: ${availGB}GB | Swap: ${swapUsedGB}/${swapGB}GB (${stats.swapPercent.toFixed(1)}%)`;
}
