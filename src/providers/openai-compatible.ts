import OpenAI from 'openai';
import { getApiKey } from '../util/env.js';
import type {
  LLMProvider, ProviderConfig, ToolDefinition,
  HistoryMessage, LLMResponse, StreamChunk, ToolCall,
} from './types.js';

/**
 * OpenAI-compatible provider.
 * Works with: OpenAI, OpenRouter, xAI (Grok), Ollama, LM Studio,
 * Together AI, Groq, Perplexity, and any server that speaks the OpenAI API spec.
 *
 * How to target each:
 *   OpenAI:      model="gpt-4o"              apiKey=OPENAI_API_KEY
 *   OpenRouter:  model="anthropic/claude-3.5" baseUrl="https://openrouter.ai/api/v1"  apiKey=OPENROUTER_API_KEY
 *   xAI/Grok:   model="grok-beta"            baseUrl="https://api.x.ai/v1"           apiKey=XAI_API_KEY
 *   Ollama:      model="llama3.2"             baseUrl="http://localhost:11434/v1"      apiKey="ollama"
 *   LM Studio:   model="local-model"          baseUrl="http://localhost:1234/v1"       apiKey="lm-studio"
 */
export class OpenAICompatibleProvider implements LLMProvider {
  name: string;
  supportsTools = true;
  model: string;

  private client: OpenAI;
  private maxTokens: number;
  private temperature: number;

  constructor(config: ProviderConfig, providerName?: string) {
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 8096;
    this.temperature = config.temperature ?? 0.2;
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
      tools: tools.length > 0 ? tools.map(toOpenAITool) : undefined,
      messages,
    });
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
      tools: tools.length > 0 ? tools.map(toOpenAITool) : undefined,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let textBuffer = '';
    const toolCallBuilders: Map<number, { id: string; name: string; args: string }> = new Map();
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    for await (const chunk of stream) {
      // OpenAI sends a final usage-only chunk when stream_options.include_usage is set
      if (chunk.usage) {
        usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
      }
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Text content
      if (delta.content) {
        textBuffer += delta.content;
        yield { type: 'text', text: delta.content };
      }

      // Tool calls (streamed in pieces)
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

      // Finish
      const finishReason = chunk.choices[0]?.finish_reason;
      if (finishReason === 'tool_calls' || finishReason === 'stop') {
        // Finalise all tool calls
        const calls: ToolCall[] = [];
        for (const [, b] of toolCallBuilders) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(b.args); } catch { input = { _raw: b.args }; }
          const call: ToolCall = { id: b.id, name: b.name, input };
          calls.push(call);
          yield { type: 'tool_end', call };
        }
        yield {
          type: 'done',
          response: {
            text: textBuffer,
            toolCalls: calls,
            stopReason: finishReason === 'tool_calls' ? 'tools' : 'done',
            usage,
          },
        };
        return;
      }
    }

    yield { type: 'done', response: { text: textBuffer, toolCalls: [], stopReason: 'done', usage } };
  }
}

// ── Conversion helpers ──────────────────────────────────────────────────────

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
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(tc.function.arguments); } catch { input = { _raw: tc.function.arguments }; }
    return { id: tc.id, name: tc.function.name, input };
  });

  const stopReason =
    choice.finish_reason === 'tool_calls' ? 'tools' :
    choice.finish_reason === 'length' ? 'limit' : 'done';

  const u = response.usage;
  return {
    text, toolCalls, stopReason,
    usage: u ? { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 } : undefined,
  };
}

// ── Auto-resolution helpers ─────────────────────────────────────────────────

function deriveProviderName(config: ProviderConfig): string {
  const m = config.model.toLowerCase();
  if (config.baseUrl?.includes('openrouter')) return 'OpenRouter';
  if (config.baseUrl?.includes('x.ai') || m.includes('grok')) return 'xAI';
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
  if (config.baseUrl?.includes('localhost') || config.baseUrl?.includes('127.0.0.1')) return 'local';
  return getApiKey('OPENAI_API_KEY') ?? '';
}

function resolveBaseUrl(config: ProviderConfig): string | undefined {
  const m = config.model.toLowerCase();
  if (m.includes('grok')) return 'https://api.x.ai/v1';
  return undefined; // default OpenAI
}
