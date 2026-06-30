/**
 * Circuit breaker. Trips after N consecutive failures within a time window,
 * then refuses new calls for a cooldown period. Half-open after cooldown:
 * a single trial call decides whether to close again or stay open.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Trip after this many consecutive failures. Default 5. */
  failureThreshold?: number;
  /** Time in ms before trying again after the breaker opens. Default 30_000. */
  cooldownMs?: number;
  /** Called on every state transition — for observability. */
  onStateChange?: (state: CircuitState, info: { failures: number; reason?: string }) => void;
  /** Sleep function for testing. */
  sleep?: (ms: number) => Promise<void>;
}

export class CircuitOpenError extends Error {
  constructor(public readonly until: number) {
    super(`Circuit breaker open until ${new Date(until).toISOString()}`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldown: number;
  private readonly onStateChange?: CircuitBreakerOptions['onStateChange'];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldown = opts.cooldownMs ?? 30_000;
    this.onStateChange = opts.onStateChange;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /**
   * Run `fn`. If the breaker is open and still cooling down, throws CircuitOpenError
   * without calling `fn`. Records success/failure and manages state.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.cooldown) {
        this.transition('half-open', 'cooldown elapsed');
      } else {
        throw new CircuitOpenError(this.openedAt + this.cooldown);
      }
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (e) {
      this.onFailure(e);
      throw e;
    }
  }

  /** Synchronous state check (mostly for tests). */
  getState(): CircuitState { return this.state; }
  getFailureCount(): number { return this.failures; }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state !== 'closed') this.transition('closed', 'call succeeded');
  }

  private onFailure(e: unknown): void {
    this.failures++;
    if (this.state === 'half-open' || (this.state === 'closed' && this.failures >= this.threshold)) {
      this.openedAt = Date.now();
      this.transition('open', e instanceof Error ? e.message : String(e));
    }
  }

  private transition(to: CircuitState, reason?: string): void {
    if (this.state === to) return;
    this.state = to;
    if (to === 'closed') this.failures = 0;
    this.onStateChange?.(to, { failures: this.failures, reason });
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
