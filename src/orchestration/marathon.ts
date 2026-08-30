/**
 * Marathon mode: the flag that says "this is a long haul".
 *
 * What this is, precisely, so the next person does not have to read the call
 * sites to find out: a process-global switch with an expiry. `:marathon` turns
 * it on, it turns itself off after 24 hours, and `getState()` reports it.
 *
 * What it is NOT, yet: nothing in the agent loop consumes it. Turning it on
 * does not change how a turn runs, does not spawn parallel agents, and does
 * not alter backoff or compaction. It was previously announced as doing all
 * three; it never did, and a banner that describes work the code does not do
 * is worse than no banner, because it is the operator who ends up debugging
 * the gap.
 *
 * This module replaced `shared-environment.ts`, which shipped a SharedMutex
 * and a CheckerGatekeeper alongside this. Both were imported by nothing, and
 * both were wrong in ways that would have bitten the moment they were wired:
 * the mutex resolved a file path and then ignored it, so it serialised every
 * agent against every file rather than locking per path, and it tracked read
 * locks in a Set keyed by agent, so releasing one of an agent's two locks
 * released them all and let a writer in underneath a live reader. The syntax
 * gate counted brackets character by character, so `const closing = "}"` was
 * judged invalid — as would most real files. The churn heuristic set-compared
 * line contents, scoring a fully reordered file as zero churn, the most
 * "surgical" patch possible. And the dry-run compiler wrote its temp file into
 * the source tree, named a `.tsx` file `.ts` so JSX could never parse, and ran
 * `tsc` on a lone file where the project's tsconfig did not apply.
 *
 * Those are all fixable, and worth building when parallel agents actually
 * land. They are not worth keeping as dead code that reads like a finished
 * feature. The original is recoverable from this file's history.
 */

/** How long a marathon lasts before it lapses on its own. */
export const MARATHON_DURATION_MS = 24 * 60 * 60 * 1000;

export interface MarathonState {
  enabled: boolean;
  /** Epoch ms when it was switched on, or null. */
  activatedAt: number | null;
  /** Epoch ms when it lapses, or null. */
  expiresAt: number | null;
  /** Milliseconds left, floored at 0. */
  remainingMs: number;
}

const OFF: MarathonState = {
  enabled: false,
  activatedAt: null,
  expiresAt: null,
  remainingMs: 0,
};

export class MarathonManager {
  private static activatedAt: number | null = null;
  private static durationMs = MARATHON_DURATION_MS;

  /**
   * Switch it on, or restart the clock if it is already on.
   *
   * @param durationMs how long it should last. Defaults to 24 hours.
   */
  static activate(durationMs = MARATHON_DURATION_MS): void {
    this.activatedAt = Date.now();
    this.durationMs = durationMs > 0 ? durationMs : MARATHON_DURATION_MS;
  }

  static deactivate(): void {
    this.activatedAt = null;
  }

  /**
   * Is it on right now?
   *
   * Expiry is computed on read rather than cleared by a timer: a timer would
   * hold the process open and would need cancelling on every exit path, and
   * this answers the same question without either.
   */
  static isActive(now = Date.now()): boolean {
    return this.activatedAt !== null && now < this.activatedAt + this.durationMs;
  }

  static getState(now = Date.now()): MarathonState {
    if (!this.isActive(now)) return { ...OFF };
    const activatedAt = this.activatedAt as number;
    const expiresAt = activatedAt + this.durationMs;
    return {
      enabled: true,
      activatedAt,
      expiresAt,
      remainingMs: Math.max(0, expiresAt - now),
    };
  }

  /** Test seam. Production code has no reason to call this. */
  static reset(): void {
    this.activatedAt = null;
    this.durationMs = MARATHON_DURATION_MS;
  }
}

/** "23h 41m", or "under a minute". For status lines. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return 'under a minute';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
