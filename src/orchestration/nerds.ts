/**
 * "nerds" — one writer at a time, readers as many as you like.
 *
 * Aura runs board tasks concurrently with no coordination: the only guard is
 * per-task, and the write tools do no locking. Two agents editing one file is
 * last-write-wins, silently, with nothing to diagnose it from afterwards.
 *
 * The policy here is the cheap fix for that, chosen over git worktrees.
 * Read-only work cannot corrupt anything, so it runs unrestricted. Work that
 * can write takes a single lease; the rest queue in arrival order and are
 * handed the lease as it frees.
 *
 * Scope, stated plainly: this is the lease, not the enforcement. Callers must
 * ask. The place to ask is `boardRun`, which is where a task becomes a running
 * agent — see HANDOFF.md.
 *
 * Deliberately not a mutex over file paths. Per-path locking sounds finer
 * grained and is a trap: an agent does not declare which files it will touch
 * before it runs, so the lock can only be taken after the first write, which is
 * after the collision. One lease over the project is coarse, correct, and
 * needs nothing the caller cannot know up front.
 */

export interface NerdsLease {
  /** True when the caller may write now. False means it is queued. */
  granted: boolean;
  /** Position in the queue when not granted; 0 when granted. */
  position: number;
}

export interface NerdsState {
  enabled: boolean;
  /** Id of the task holding the write lease, if any. */
  holder: string | null;
  /** Ids waiting for it, in the order they asked. */
  waiting: string[];
}

type Waiter = { id: string; resolve: () => void };

export class NerdsPolicy {
  private static on = false;
  private static holder: string | null = null;
  private static queue: Waiter[] = [];

  static enable(): void { this.on = true; }

  /**
   * Turn it off and release everyone.
   *
   * Waiters are resolved rather than dropped: they are already blocked on this
   * promise, and leaving them pending would hang the tasks instead of freeing
   * them.
   */
  static disable(): void {
    this.on = false;
    this.holder = null;
    const waiting = this.queue.splice(0);
    for (const w of waiting) w.resolve();
  }

  static isEnabled(): boolean { return this.on; }

  static getState(): NerdsState {
    return { enabled: this.on, holder: this.holder, waiting: this.queue.map((w) => w.id) };
  }

  /**
   * Ask to write. Resolves immediately when the lease is free or the policy is
   * off, otherwise when the tasks ahead have released it.
   *
   * Re-entrant for the current holder: a task that already holds the lease and
   * asks again gets it, rather than queueing behind itself forever.
   */
  static async acquireWriter(taskId: string): Promise<void> {
    if (!this.on || this.holder === null || this.holder === taskId) {
      this.holder = taskId;
      return;
    }
    // No assignment after the await on purpose. `releaseWriter` sets the
    // holder before resolving the next waiter, and `disable` resolves everyone
    // with no holder at all — re-claiming it here would resurrect a holder the
    // moment the policy was turned off.
    await new Promise<void>((resolve) => this.queue.push({ id: taskId, resolve }));
  }

  /**
   * Would this task have to wait? Answers without joining the queue, so a
   * caller can show "waiting" on the board before committing to block.
   */
  static inspect(taskId: string): NerdsLease {
    if (!this.on || this.holder === null || this.holder === taskId) {
      return { granted: true, position: 0 };
    }
    const existing = this.queue.findIndex((w) => w.id === taskId);
    return { granted: false, position: existing >= 0 ? existing + 1 : this.queue.length + 1 };
  }

  /**
   * Release the lease and hand it to the next in line.
   *
   * A release from a task that is not the holder is ignored rather than
   * throwing: a cancelled or crashed task may release twice, and the second
   * one must not eject whoever legitimately holds it by then.
   */
  static releaseWriter(taskId: string): void {
    if (this.holder !== taskId) return;
    const next = this.queue.shift();
    if (next) {
      this.holder = next.id;
      next.resolve();
    } else {
      this.holder = null;
    }
  }

  /** Test seam. */
  static reset(): void {
    this.on = false;
    this.holder = null;
    this.queue = [];
  }
}
