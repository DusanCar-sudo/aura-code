import OpenAI from 'openai';
import { getApiKey } from '../util/env.js';
import { safeParseToolArgs } from '../util/json-repair.js';
import { ThinkTagStripper, readReasoningField, resolveAnswer } from './reasoning.js';
import { withIdleTimeout, streamIdleMs, isStreamStalled } from './stream-timeout.js';
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

  /**
   * A stalled stream is retried exactly once, and only when nothing has
   * reached the consumer yet. Once text has been yielded, the loop has already
   * accumulated it and displayed it — re-running the request would append a
   * second full response, corrupting both the transcript and the token count.
   * In that case the stall surfaces as an error instead, which the agent loop
   * reports as a provider failure rather than hanging forever.
   */
  async *stream(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    let delivered = 0;
    try {
      for await (const chunk of this.streamOnce(system, history, tools)) {
        delivered++;
        yield chunk;
      }
      return;
    } catch (err) {
      if (!isStreamStalled(err) || delivered > 0) throw err;
    }
    // Nothing was delivered, so this retry cannot duplicate output.
    yield* this.streamOnce(system, history, tools);
  }

  private async *streamOnce(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    const messages = toOpenAIMessages(system, history);
    // Lets the idle guard tear down the socket instead of leaking it.
    const controller = new AbortController();
    const rawStream = await this.client.chat.completions.create({
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
    } as OpenAI.ChatCompletionCreateParamsStreaming, { signal: controller.signal });
    const stream = withIdleTimeout(rawStream, {
      idleMs: streamIdleMs(),
      onStall: () => controller.abort(),
    });

    let textBuffer = '';
    let reasoningBuffer = '';
    const stripper = new ThinkTagStripper();
    const toolCallBuilders: Map<number, { id: string; name: string; args: string }> = new Map();
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let finishReason: string | undefined;
    // AURA_DEBUG_CACHE prints one line per API call. Some providers attach
    // `usage` to every streamed chunk, so without this the same figures
    // scrolled dozens of times per response and buried the actual output.
    let loggedCacheDebug = false;

    // CRITICAL: do NOT return early when finish_reason arrives.
    // With stream_options.include_usage, OpenAI sends a trailing usage-only
    // chunk AFTER the finish_reason chunk. Returning early drops it -- usage
    // stays undefined, token/cost accounting reads 0, and compaction never
    // fires. Drain the entire stream, then finalize.
    for await (const chunk of stream) {
      if (chunk.usage) {
        const { cacheHit, cacheMiss, reported } = readCacheStats(chunk.usage);
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          ...(cacheHit > 0 ? { cachedTokens: cacheHit } : {}),
        };
        // Only when the provider actually reported cache figures: otherwise
        // `miss` is inferred from the prompt size and printing it would imply
        // a measured miss where nothing was measured at all.
        if (process.env.AURA_DEBUG_CACHE && reported && !loggedCacheDebug) {
          loggedCacheDebug = true;
          console.error(`[cache] hit=${cacheHit} miss=${cacheMiss} input=${chunk.usage.prompt_tokens ?? 0}`);
        }
      }

      const choice = chunk.choices[0];
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice?.delta;
      if (!delta) continue;

      // Reasoning models split chain-of-thought off into its own field and
      // leave `content` empty until thinking ends. Collect it — never render
      // it — so a response whose budget went entirely to thinking still has
      // something to fall back on instead of surfacing as an empty answer.
      reasoningBuffer += readReasoningField(delta);

      if (delta.content) {
        // Other stacks put the same trace in-band as <think>…</think>; strip
        // it here rather than leaking it into the visible answer.
        const visible = stripper.push(delta.content);
        if (visible) {
          textBuffer += visible;
          yield { type: 'text', text: visible };
        }
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

    // Release anything the tag stripper was holding back (a chunk boundary
    // mid-tag), then decide what the answer actually is.
    const tail = stripper.flush();
    if (tail) {
      textBuffer += tail;
      yield { type: 'text', text: tail };
    }
    const reasoning = reasoningBuffer + stripper.reasoningText;
    const answer = resolveAnswer(textBuffer, reasoning);
    if (answer !== textBuffer) {
      // Content-only-in-reasoning: nothing was streamed to the display, so
      // emit the fallback now rather than completing with a blank screen.
      yield { type: 'text', text: answer };
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
        text: answer,
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
      if (msg.images && msg.images.length > 0) {
        // Multimodal: images first, then text
        out.push({
          role: 'user',
          content: [
            ...msg.images.map(img => ({
              type: 'image_url' as const,
              image_url: { url: img }
            })),
            { type: 'text' as const, text: msg.content }
          ]
        });
      } else {
        out.push({ role: 'user', content: msg.content });
      }
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

  // Same two reasoning shapes as the streaming path — see reasoning.ts.
  const rawContent = choice.message.content ?? '';
  const stripper = new ThinkTagStripper();
  const stripped = stripper.push(rawContent) + stripper.flush();
  const text = resolveAnswer(
    stripped,
    readReasoningField(choice.message) + stripper.reasoningText,
  );
  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map(tc => {
    const input: Record<string, unknown> = safeParseToolArgs(tc.function.arguments);
    return { id: tc.id, name: tc.function.name, input };
  });

  const stopReason =
    choice.finish_reason === 'tool_calls' ? 'tools' :
    choice.finish_reason === 'length' ? 'limit' : 'done';

  const u = response.usage;
  if (!u) return { text, toolCalls, stopReason };

  const { cacheHit } = readCacheStats(u);
  return {
    text, toolCalls, stopReason,
    usage: {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      ...(cacheHit > 0 ? { cachedTokens: cacheHit } : {}),
    },
  };
}

/**
 * Read prompt-cache stats from an OpenAI-compatible usage object.
 *
 * Two dialects are in the wild and providers pick one:
 *  - OpenAI standard: `prompt_tokens_details.cached_tokens` (OpenAI itself,
 *    Zhipu/GLM, and most compatible vendors).
 *  - DeepSeek: top-level `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`.
 *
 * Only the DeepSeek pair used to be read, so every other provider reported no
 * cache hits and costFor billed the whole prompt at the uncached rate — which
 * silently overstated cost by up to ~10x on a cached turn and made it
 * impossible to tell whether caching was working at all.
 *
 * The SDK passes unknown fields through, so both dialects are readable here.
 */
export function readCacheStats(
  usage: OpenAI.CompletionUsage,
): { cacheHit: number; cacheMiss: number; reported: boolean } {
  const u = usage as OpenAI.CompletionUsage & {
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };

  // Prefer whichever dialect actually reports a hit; a provider that sends
  // neither yields 0 and cachedTokens stays unset (full-rate billing).
  const standard = u.prompt_tokens_details?.cached_tokens;
  const deepseek = u.prompt_cache_hit_tokens;
  const cacheHit = Math.max(standard ?? 0, deepseek ?? 0);

  const prompt = u.prompt_tokens ?? 0;
  const cacheMiss = u.prompt_cache_miss_tokens ?? Math.max(0, prompt - cacheHit);

  // Whether any cache field was present at all. `cacheMiss` falls back to the
  // whole prompt when nothing was reported, so callers that would otherwise
  // read "miss = 20,940" as a measurement need to tell the two apart — an
  // inferred miss says nothing about whether the provider caches.
  const reported =
    standard !== undefined || deepseek !== undefined || u.prompt_cache_miss_tokens !== undefined;

  return { cacheHit, cacheMiss, reported };
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
