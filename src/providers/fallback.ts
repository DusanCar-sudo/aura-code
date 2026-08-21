import type { LLMProvider, LLMResponse, StreamChunk, HistoryMessage, ToolDefinition } from '../providers/types.js';
import { normaliseError } from '../util/errors.js';

/**
 * Chains N providers and auto-failover: if the primary exhausts retries /
 * the breaker is open, the next provider is tried. Continues until one
 * succeeds or all fail.
 */
export class FallbackChainProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly supportsTools: boolean;
  private readonly providers: LLMProvider[];
  private readonly onFailover?: (info: { from: string; to: string; reason: string }) => void;

  constructor(providers: LLMProvider[], opts: { onFailover?: (info: { from: string; to: string; reason: string }) => void } = {}) {
    if (providers.length === 0) throw new Error('FallbackChainProvider requires at least one provider');
    this.providers = providers;
    this.onFailover = opts.onFailover;
    this.name = providers[0].name;
    this.model = providers[0].model;
    this.supportsTools = providers.every(p => p.supportsTools);
  }

  /** Underlying providers in priority order. */
  get chain(): readonly LLMProvider[] { return this.providers; }

  async complete(system: string, history: HistoryMessage[], tools: ToolDefinition[]): Promise<LLMResponse> {
    let lastErr: unknown;
    for (let i = 0; i < this.providers.length; i++) {
      const p = this.providers[i];
      try {
        return await p.complete(system, history, tools);
      } catch (e) {
        lastErr = e;
        const next = this.providers[i + 1];
        if (!next) break;
        // Only failover on retriable errors; permanent ones (4xx) propagate.
        // Normalise first: providers throw their SDK's own error class, so an
        // `instanceof ApiError` test alone silently answered "not permanent"
        // for a raw 400 and "permanent" for anything a caller had already
        // mislabelled. Deciding on the parsed HTTP status is the point.
        if (!normaliseError(e, p.name).retriable) throw e;
        this.onFailover?.({ from: p.name, to: next.name, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    throw lastErr ?? new Error('Fallback chain produced no result');
  }

  async *stream(system: string, history: HistoryMessage[], tools: ToolDefinition[]): AsyncGenerator<StreamChunk> {
    let lastErr: unknown;
    for (let i = 0; i < this.providers.length; i++) {
      const p = this.providers[i];
      try {
        const gen = p.stream(system, history, tools);
        for await (const chunk of gen) {
          yield chunk;
        }
        return;
      } catch (e) {
        lastErr = e;
        const next = this.providers[i + 1];
        if (!next) break;
        if (!normaliseError(e, p.name).retriable) throw e;
        this.onFailover?.({ from: p.name, to: next.name, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    throw lastErr ?? new Error('Fallback chain produced no stream');
  }
}
