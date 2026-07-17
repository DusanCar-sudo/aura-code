import OpenAI from 'openai';
import { getApiKey } from '../util/env.js';
import { safeParseToolArgs } from '../util/json-repair.js';
import type {
  LLMProvider, ProviderConfig, ToolDefinition,
  HistoryMessage, LLMResponse, StreamChunk, ToolCall,
} from './types.js';

export class OpenAICompatibleProvider implements LLMProvider {
  name: string;
  supportsTools = true;
  model: string;

  private client: OpenAI;
  private maxTokens: number;
  private temperature: number;
  private frequencyPenalty: number;
  private presencePenalty: number;
  private reasoningEffort?: string;

  constructor(config: ProviderConfig, providerName?: string) {
    this.model = config.model;
    // Reasoning models (GLM-5.x, MiMo, DeepSeek-R, o-series) spend tokens on
    // internal reasoning BEFORE emitting visible content. A small cap suffocates
    // them: budget exhausted mid-think -> finish_reason "length" -> zero output.
    this.maxTokens = config.maxTokens ?? 16384;
    this.reasoningEffort = deriveProviderName(config) === 'Zhipu' ? 'high' : undefined;
    this.temperature = config.temperature ?? 0.2;
    // Nonzero penalties discourage degenerate repetition loops (observed live
    // with DeepSeek); 0.3 is conservative enough not to hurt code generation.
    this.frequencyPenalty = config.frequencyPenalty ?? 0.3;
    this.presencePenalty = config.presencePenalty ?? 0.3;
    this.name = providerName ?? deriveProviderName(config);

    this.client = new OpenAI({
      apiKey: config.apiKey ?? resolveApiKey(config),
      baseURL: config.baseUrl ?? resolveBaseUrl(config),
    });
  }

  async complete(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): Promise<LLMResponse> {
    const messages = toOpenAIMessages(system, history);
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      frequency_penalty: this.frequencyPenalty,
      presence_penalty: this.presencePenalty,
      tools: tools.length > 0 ? tools.map(toOpenAITool) : undefined,
      messages,
      // GLM defaults to "max" thinking effort (~85k reasoning tokens per Z.ai's
      // own benchmarks) before writing any visible content. "high" keeps useful
      // reasoning for code quality while roughly halving that token burn.
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
    } as OpenAI.ChatCompletionCreateParamsNonStreaming);
    return fromOpenAIResponse(response);
  }

  async *stream(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    const messages = toOpenAIMessages(system, history);
    const stream = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      frequency_penalty: this.frequencyPenalty,
      presence_penalty: this.presencePenalty,
      tools: tools.length > 0 ? tools.map(toOpenAITool) : undefined,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
    } as OpenAI.ChatCompletionCreateParamsStreaming);

    let textBuffer = '';
    const toolCallBuilders: Map<number, { id: string; name: string; args: string }> = new Map();
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let finishReason: string | undefined;

    // CRITICAL: do NOT return early when finish_reason arrives.
    // With stream_options.include_usage, OpenAI sends a trailing usage-only
    // chunk AFTER the finish_reason chunk. Returning early drops it -- usage
    // stays undefined, token/cost accounting reads 0, and compaction never
    // fires. Drain the entire stream, then finalize.
    for await (const chunk of stream) {
      if (chunk.usage) {
        // DeepSeek reports cache stats via prompt_cache_hit_tokens /
        // prompt_cache_miss_tokens in the usage object. The OpenAI SDK
        // passes unknown fields through, so we can read them here.
        const raw = chunk.usage as OpenAI.CompletionUsage & {
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
        };
        const cacheHit = raw.prompt_cache_hit_tokens ?? 0;
        const cacheMiss = raw.prompt_cache_miss_tokens ?? 0;
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          // Only set cachedTokens when the provider actually reports them
          // (DeepSeek). Other OpenAI-compatible providers don't set these
          // fields, so cachedTokens stays undefined and costFor uses the
          // standard rate for all input tokens.
          ...(cacheHit > 0 ? { cachedTokens: cacheHit } : {}),
        };
        if (process.env.AURA_DEBUG_CACHE && (cacheHit > 0 || cacheMiss > 0)) {
          console.error(`[cache] hit=${cacheHit} miss=${cacheMiss} input=${chunk.usage.prompt_tokens ?? 0}`);
        }
      }

      const choice = chunk.choices[0];
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice?.delta;
      if (!delta) continue;

      if (delta.content) {
        textBuffer += delta.content;
        yield { type: 'text', text: delta.content };
      }

      for (const tc of delta.tool_calls ?? []) {
        if (!toolCallBuilders.has(tc.index)) {
          const id = tc.id ?? `tc_${tc.index}`;
          const name = tc.function?.name ?? '';
          toolCallBuilders.set(tc.index, { id, name, args: '' });
          yield { type: 'tool_start', id, name };
        }
        const builder = toolCallBuilders.get(tc.index)!;
        if (tc.function?.arguments) {
          builder.args += tc.function.arguments;
          yield { type: 'tool_input', id: builder.id, partial: tc.function.arguments };
        }
      }
    }

    const calls: ToolCall[] = [];
    for (const [, b] of toolCallBuilders) {
      const input: Record<string, unknown> = safeParseToolArgs(b.args);
      const call: ToolCall = { id: b.id, name: b.name, input };
      calls.push(call);
      yield { type: 'tool_end', call };
    }

    // Map finish_reason -> stopReason. "length" means the response was
    // TRUNCATED by max_tokens -- it must never be mislabeled as a clean "done".
    const stopReason =
      finishReason === 'tool_calls' ? 'tools' :
      finishReason === 'length' ? 'limit' : 'done';

    yield {
      type: 'done',
      response: {
        text: textBuffer,
        toolCalls: calls,
        stopReason,
        usage,
      },
    };
  }
}

// -- Conversion helpers ------------------------------------------------------

function toOpenAITool(t: ToolDefinition): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

function toOpenAIMessages(
  system: string,
  history: HistoryMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];

  for (const msg of history) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map(tc => ({
            id: tc.id, type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
      } else {
        out.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool_result') {
      for (const r of msg.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
    }
  }
  return out;
}

function fromOpenAIResponse(response: OpenAI.ChatCompletion): LLMResponse {
  const choice = response.choices[0];
  if (!choice) return { text: '', toolCalls: [], stopReason: 'done' };

  const text = choice.message.content ?? '';
  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map(tc => {
    const input: Record<string, unknown> = safeParseToolArgs(tc.function.arguments);
    return { id: tc.id, name: tc.function.name, input };
  });

  const stopReason =
    choice.finish_reason === 'tool_calls' ? 'tools' :
    choice.finish_reason === 'length' ? 'limit' : 'done';

  const u = response.usage as OpenAI.CompletionUsage & {
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  } | undefined;
  if (!u) return { text, toolCalls, stopReason };

  const cacheHit = u.prompt_cache_hit_tokens ?? 0;
  return {
    text, toolCalls, stopReason,
    usage: {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      ...(cacheHit > 0 ? { cachedTokens: cacheHit } : {}),
    },
  };
}

// -- Auto-resolution helpers --------------------------------------------------

function deriveProviderName(config: ProviderConfig): string {
  const m = config.model.toLowerCase();
  if (config.baseUrl?.includes('openrouter')) return 'OpenRouter';
  if (config.baseUrl?.includes('x.ai') || m.includes('grok')) return 'xAI';
  if (config.baseUrl?.includes('api.z.ai') || m.startsWith('glm-')) return 'Zhipu';
  if (config.baseUrl?.includes('localhost') || config.baseUrl?.includes('127.0.0.1')) {
    return config.baseUrl?.includes('11434') ? 'Ollama' : 'Local';
  }
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3')) return 'OpenAI';
  return 'OpenAI-compatible';
}

function resolveApiKey(config: ProviderConfig): string {
  const m = config.model.toLowerCase();
  if (config.baseUrl?.includes('openrouter')) return getApiKey('OPENROUTER_API_KEY') ?? '';
  if (config.baseUrl?.includes('x.ai') || m.includes('grok')) return getApiKey('XAI_API_KEY') ?? '';
  if (config.baseUrl?.includes('xiaomimimo') || m.startsWith('mimo-')) return getApiKey('XIAOMI_API_KEY') ?? '';
  if (config.baseUrl?.includes('api.z.ai') || m.startsWith('glm-')) return getApiKey('ZHIPU_API_KEY') ?? '';
  if (config.baseUrl?.includes('localhost') || config.baseUrl?.includes('127.0.0.1')) return 'local';
  return getApiKey('OPENAI_API_KEY') ?? '';
}

function resolveBaseUrl(config: ProviderConfig): string | undefined {
  const m = config.model.toLowerCase();
  if (m.includes('grok')) return 'https://api.x.ai/v1';
  return undefined; // default OpenAI
}
