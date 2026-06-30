import type { LLMProvider, ProviderConfig } from './types.js';
import { createProvider, detectProviderKind } from './factory.js';
import { ResilientProvider, type ResilientOptions } from './resilient.js';
import { FallbackChainProvider } from './fallback.js';
import type { Display } from '../cli/display.js';

export interface ResilienceConfig {
  /** Requests per minute (0 = unlimited). Default 0. */
  rpm?: number;
  /** Tokens per minute (0 = unlimited). Default 0. */
  tpm?: number;
  /** Burst capacity for the rate limiter. Default rpm/6. */
  burst?: number;
  /** Max retry attempts. Default 5. */
  maxRetries?: number;
  /** Circuit-breaker failure threshold. Default 5. */
  circuitFailureThreshold?: number;
  /** Circuit-breaker cooldown ms. Default 30000. */
  circuitCooldownMs?: number;
  /** Fallback model ids tried in order if the primary exhausts retries. */
  fallbacks?: string[];
}

/** Sensible defaults per provider family. */
const DEFAULTS_BY_KIND: Record<string, Partial<ResilienceConfig>> = {
  google: { rpm: 30, tpm: 1_000_000, burst: 5, maxRetries: 6 },
  anthropic: { rpm: 50, burst: 8, maxRetries: 5 },
  'openai-compatible': { rpm: 60, burst: 10, maxRetries: 5 },
};

/**
 * Build a provider wrapped in resilience + optional fallback chain.
 * The returned object is what the agent loop uses — it doesn't know
 * whether it's wrapped.
 */
export function createResilientProvider(
  config: ProviderConfig,
  resilience: ResilienceConfig,
  display?: Display,
): LLMProvider {
  const kind = detectProviderKind(config.model);
  const merged: ResilienceConfig = { ...DEFAULTS_BY_KIND[kind], ...resilience };

  const resilientOpts: ResilientOptions = {
    rpm: merged.rpm,
    tpm: merged.tpm,
    burst: merged.burst,
    maxRetries: merged.maxRetries,
    circuitFailureThreshold: merged.circuitFailureThreshold,
    circuitCooldownMs: merged.circuitCooldownMs,
    onRetry: ({ provider, attempt, delayMs, error }) => {
      display?.retry?.({
        provider,
        attempt,
        delayMs,
        reason: error.status === 429 ? 'rate limited' :
                error.status === 529 ? 'provider overloaded' :
                error.status === 0   ? 'network error' :
                `HTTP ${error.status}`,
      });
    },
    onRateLimitWait: (provider, waitMs) => {
      // Only surface when the wait is meaningful (>100ms)
      if (waitMs > 100) display?.retry?.({ provider, attempt: 0, delayMs: waitMs, reason: 'pacing' });
    },
    onCircuitChange: (provider, state) => display?.circuit?.({ provider, state }),
  };

  const primary = new ResilientProvider(createProvider(config), resilientOpts);
  if (!merged.fallbacks || merged.fallbacks.length === 0) return primary;

  const fallbackProviders: LLMProvider[] = merged.fallbacks.map(model => {
    const fc: ProviderConfig = { ...config, model };
    return new ResilientProvider(createProvider(fc), resilientOpts);
  });

  return new FallbackChainProvider([primary, ...fallbackProviders], {
    onFailover: ({ from, to, reason }) => display?.failover?.({ from, to, reason }),
  });
}
