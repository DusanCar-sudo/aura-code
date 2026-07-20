import type {
  LLMProvider,
  ToolDefinition,
  HistoryMessage,
  LLMResponse,
  StreamChunk,
} from '../providers/types.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import type { ArchimedesConfig } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// ArchimedesModel — small local model via Ollama
// ─────────────────────────────────────────────────────────────────────────────

interface OllamaTagsResponse {
  models?: { name: string }[];
}

/**
 * {@link LLMProvider} implementation for the Archimedes Principle small model.
 * Delegates completions to {@link OpenAICompatibleProvider} against Ollama.
 */
export class ArchimedesModel implements LLMProvider {
  readonly name = 'Archimedes';
  supportsTools = true;
  model: string;

  private readonly config: ArchimedesConfig;
  private delegate: OpenAICompatibleProvider;

  constructor(config: ArchimedesConfig) {
    this.config = config;
    this.model = config.modelName;
    this.delegate = this.buildDelegate();
  }

  /**
   * One-shot completion via the Ollama OpenAI-compatible endpoint.
   */
  async complete(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): Promise<LLMResponse> {
    return this.delegate.complete(system, history, tools);
  }

  /**
   * Streaming completion via the Ollama OpenAI-compatible endpoint.
   */
  async *stream(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    yield* this.delegate.stream(system, history, tools);
  }

  /**
   * Returns true when Ollama is reachable and lists {@link model}.
   * Never throws.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const root = ollamaRoot(this.config.ollamaBaseUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      const res = await fetch(`${root}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const body = (await res.json()) as OllamaTagsResponse;
      const names = (body.models ?? []).map(m => m.name);
      const wanted = this.model;
      return names.some(
        n => n === wanted || n.startsWith(`${wanted}:`) || n.split(':')[0] === wanted,
      );
    } catch {
      return false;
    }
  }

  /**
   * Returns the current Ollama model tag in use.
   */
  async getVersion(): Promise<string> {
    return this.model;
  }

  /**
   * Switches the active Ollama model and rebuilds the delegate provider.
   */
  async updateModel(newModelName: string): Promise<void> {
    this.model = newModelName;
    this.config.modelName = newModelName;
    this.delegate = this.buildDelegate();
  }

  private buildDelegate(): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider(
      {
        model: this.model,
        baseUrl: this.config.ollamaBaseUrl,
        apiKey: 'ollama',
      },
      'Archimedes',
    );
  }
}

function ollamaRoot(baseUrl: string): string {
  const trimmed = (baseUrl ?? 'http://localhost:11434/v1').replace(/\/v1\/?$/, '').replace(/\/$/, '');
  return trimmed || 'http://localhost:11434';
}