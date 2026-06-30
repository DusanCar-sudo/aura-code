import type { LLMProvider, LLMResponse, StreamChunk, HistoryMessage, ToolDefinition } from '../providers/types.js';
import { withRetry, type RetryOptions } from '../util/retry.js';
import { RateLimiter, TpmTracker } from '../util/rate-limiter.js';
import { CircuitBreaker, CircuitOpenError } from '../util/circuit-breaker.js';
import { ApiError, normaliseError } from '../util/errors.js';

export interface ResilientOptions {
  /** Requests per minute budget. 0 = unlimited. Default 0. */
  rpm?: number;
  /** Tokens per minute budget (Gemini-style). 0 = unlimited. */
  tpm?: number;
  /** Burst size — max tokens consumable in a quick burst. Default rpm/6. */
  burst?: number;
  /** Max retry attempts. Default 5. */
  maxRetries?: number;
  /** Cooldown when circuit is open. Default 30s. */
  circuitCooldownMs?: number;
  /** Consecutive failures before circuit opens. Default 5. */
  circuitFailureThreshold?: number;
  /** Surface retry events (for the CLI display). */
  onRetry?: (info: { provider: string; attempt: number; delayMs: number; error: ApiError }) => void;
  /** Surface circuit-breaker state changes. */
  onCircuitChange?: (provider: string, state: 'closed' | 'open' | 'half-open') => void;
  /** Surface rate-limit waits (acquire returned > 0ms). */
  onRateLimitWait?: (provider: string, waitMs: number) => void;
  /** Sleep function for testing. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wrap a provider with rate limiting, circuit breaking, and retries.
 * The wrapper itself implements LLMProvider, so the agent loop doesn't
 * need to know whether it's wrapped.
 */
export class ResilientProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly supportsTools: boolean;
  private readonly inner: LLMProvider;
  private readonly rpmLimiter: RateLimiter;
  private readonly tpm: TpmTracker | null;
  private readonly breaker: CircuitBreaker;
  private readonly opts: ResilientOptions;
  /** True once we've observed the provider work end-to-end. Used to gate TPM-based throttling. */
  private tpmObserved = false;

  constructor(inner: LLMProvider, opts: ResilientOptions = {}) {
    this.inner = inner;
    this.name = inner.name;
    this.model = inner.model;
    this.supportsTools = inner.supportsTools;
    this.opts = opts;
    const rpm = opts.rpm ?? 0;
    this.rpmLimiter = new RateLimiter({
      capacity: opts.burst ?? Math.max(1, Math.ceil(rpm / 6)),
      refillPerMs: rpm > 0 ? rpm / 60_000 : Number.MAX_SAFE_INTEGER,
      sleep: opts.sleep,
    });
    this.tpm = opts.tpm && opts.tpm > 0 ? new TpmTracker(opts.tpm) : null;
    this.breaker = new CircuitBreaker({
      failureThreshold: opts.circuitFailureThreshold ?? 5,
      cooldownMs: opts.circuitCooldownMs ?? 30_000,
      sleep: opts.sleep,
      onStateChange: (state) => opts.onCircuitChange?.(this.inner.name, state),
    });
  }

  /** Non-streaming completion. */
  async complete(system: string, history: HistoryMessage[], tools: ToolDefinition[]): Promise<LLMResponse> {
    return this.runResilient(async () => {
      const result = await this.inner.complete(system, history, tools);
      this.recordUsage(result.usage);
      return result;
    });
  }

  /**
   * Streaming completion. The wrap covers the `createStream` call (not iteration),
   * so a transient connection error retries the whole stream. Mid-stream errors
   * (after the first chunk) are NOT retried — we'd lose partial output.
   */
  async *stream(system: string, history: HistoryMessage[], tools: ToolDefinition[]): AsyncGenerator<StreamChunk> {
    // Collect chunks from the inner stream. Retry covers the call to obtain
    // the generator and any error before the first yield.
    const firstIterResult = await this.runResilient(async () => {
      return await this.firstChunkOrThrow(this.inner.stream(system, history, tools));
    });
    // firstIterResult is either { firstChunk, generator } or a thrown error.
    // After we have the first chunk, any further iteration errors propagate to the caller.
    let gen: AsyncGenerator<StreamChunk>;
    let first: StreamChunk | undefined;
    if (firstIterResult.kind === 'done') {
      // Inner stream finished without yielding anything — emit a synthetic done if needed
      yield firstIterResult.final;
      return;
    }
    gen = firstIterResult.gen;
    first = firstIterResult.first;
    yield first;
    try {
      for await (const chunk of gen) {
        if (chunk.type === 'done') {
          this.recordUsage(chunk.response.usage);
        }
        yield chunk;
      }
    } catch (e) {
      // Mid-stream error — wrap so the caller can see the cause, but do not retry
      throw normaliseError(e, this.inner.name);
    }
  }

  private async firstChunkOrThrow(
    gen: AsyncGenerator<StreamChunk>,
  ): Promise<
    | { kind: 'streaming'; gen: AsyncGenerator<StreamChunk>; first: StreamChunk }
    | { kind: 'done'; final: StreamChunk }
  > {
    const it = gen[Symbol.asyncIterator]();
    try {
      const first = await it.next();
      if (first.done) {
        // Inner stream finished without yielding — call finalMessage equivalent?
        // This shouldn't happen for our providers, but guard anyway.
        return { kind: 'done', final: { type: 'done', response: { text: '', toolCalls: [], stopReason: 'done' } } };
      }
      return { kind: 'streaming', gen: gen, first: first.value };
    } catch (e) {
      // Re-throw so retry layer sees it
      throw e;
    }
  }

  /** Acquire rate-limit + circuit slot, then call `fn` under retry. */
  private async runResilient<T>(fn: () => Promise<T>): Promise<T> {
    // 1. Wait for rate-limit token
    const waitMs = await this.rpmLimiter.acquire(1);
    if (waitMs > 0) this.opts.onRateLimitWait?.(this.inner.name, waitMs);

    // 2. Run under circuit breaker + retry
    return await this.breaker.call(async () => {
      return await withRetry(fn, {
        maxAttempts: this.opts.maxRetries ?? 5,
        baseDelayMs: 1000,
        maxDelayMs: 60_000,
        sleep: this.opts.sleep,
        onRetry: ({ attempt, delayMs, error }) => {
          this.opts.onRetry?.({ provider: this.inner.name, attempt, delayMs, error });
          // When a request was throttled, we also know its token cost is
          // bounded — give the RPM/TPM budget a chance to recover.
          if (error.retryAfterMs && this.tpm && error.tokens) {
            this.tpm.record(error.tokens.input + error.tokens.output);
          }
        },
      });
    });
  }

  private recordUsage(usage?: { inputTokens: number; outputTokens: number }): void {
    if (!usage) return;
    this.tpmObserved = true;
    if (this.tpm) this.tpm.record(usage.inputTokens + usage.outputTokens);
  }

  /** TPM helper used by the Google provider to gate heavy requests. */
  tpmHasRoomFor(n: number): boolean {
    return this.tpm ? this.tpm.hasRoomFor(n) : true;
  }

  /** Force-open the circuit (e.g. when manually disabling a provider). */
  trip(reason: string): void {
    this.breaker.call(async () => { throw new Error(reason); }).catch(() => { /* expected */ });
  }
}
