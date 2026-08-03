import type {
  LLMProvider,
  ToolDefinition,
  HistoryMessage,
  LLMResponse,
  StreamChunk,
} from '../providers/types.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import type { ArchimedesConfig } from './types.js';
import { apiRoot, resolveEndpoint, wireModelName } from './endpoint.js';

// ─────────────────────────────────────────────────────────────────────────────
// ArchimedesModel — small local model via Ollama or LM Studio
// ─────────────────────────────────────────────────────────────────────────────

interface OllamaTagsResponse {
  models?: { name: string }[];
}

interface OpenAIModelsResponse {
  data?: { id: string }[];
}

/**
 * {@link LLMProvider} implementation for the Archimedes Principle small model.
 * Delegates completions to {@link OpenAICompatibleProvider} against whichever
 * local server the config selects — Ollama or LM Studio.
 */
export class ArchimedesModel implements LLMProvider {
  readonly name = 'Archimedes';
  supportsTools = true;
  model: string;

  private readonly config: ArchimedesConfig;
  private delegate: OpenAICompatibleProvider;

  constructor(config: ArchimedesConfig) {
    this.config = config;
    // A prefixed id (`lmstudio/qwen/qwen3-1.7b`) selects the backend via
    // resolveEndpoint; only the bare id goes on the wire.
    this.model = wireModelName(config);
    this.delegate = this.buildDelegate();
  }

  /**
   * One-shot completion via the local OpenAI-compatible endpoint.
   */
  async complete(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): Promise<LLMResponse> {
    return this.delegate.complete(system, history, tools);
  }

  /**
   * Streaming completion via the local OpenAI-compatible endpoint.
   */
  async *stream(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    yield* this.delegate.stream(system, history, tools);
  }

  /**
   * Returns true when the configured local server is reachable and lists
   * {@link model}. Each backend is asked on its own terms: Ollama via
   * `/api/tags` (tag-prefix matching, so `qwen2.5-coder` matches
   * `qwen2.5-coder:1.5b`), LM Studio via `/v1/models` (exact ids, no tags).
   * Never throws.
   */
  async isAvailable(): Promise<boolean> {
    const endpoint = resolveEndpoint(this.config);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      const url = endpoint.backend === 'lmstudio'
        ? `${endpoint.baseUrl}/models`
        : `${apiRoot(endpoint.baseUrl)}/api/tags`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      });
      clearTimeout(timer);
      if (!res.ok) return false;

      const wanted = this.model;
      if (endpoint.backend === 'lmstudio') {
        const body = (await res.json()) as OpenAIModelsResponse;
        return (body.data ?? []).some(m => m.id === wanted);
      }

      const body = (await res.json()) as OllamaTagsResponse;
      const names = (body.models ?? []).map(m => m.name);
      return names.some(
        n => n === wanted || n.startsWith(`${wanted}:`) || n.split(':')[0] === wanted,
      );
    } catch {
      return false;
    }
  }

  /**
   * Returns the current local model id in use.
   */
  async getVersion(): Promise<string> {
    return this.model;
  }

  /**
   * Switches the active local model and rebuilds the delegate provider.
   * Accepts a backend-prefixed id, which also switches the backend.
   */
  async updateModel(newModelName: string): Promise<void> {
    this.config.modelName = newModelName;
    this.model = wireModelName(this.config);
    this.delegate = this.buildDelegate();
  }

  private buildDelegate(): OpenAICompatibleProvider {
    const endpoint = resolveEndpoint(this.config);
    return new OpenAICompatibleProvider(
      {
        model: this.model,
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
      },
      'Archimedes',
    );
  }
}