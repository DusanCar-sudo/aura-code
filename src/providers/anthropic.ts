import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from '../util/env.js';
import type {
  LLMProvider, ProviderConfig, ToolDefinition,
  HistoryMessage, LLMResponse, StreamChunk, ToolCall, ToolResult,
} from './types.js';

export class AnthropicProvider implements LLMProvider {
  name = 'Anthropic';
  supportsTools = true;
  model: string;

  private client: Anthropic;
  private maxTokens: number;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 8096;
    this.client = new Anthropic({
      apiKey: config.apiKey ?? getApiKey('ANTHROPIC_API_KEY'),
    });
  }

  async complete(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): Promise<LLMResponse> {
    const messages = toAnthropicMessages(history);
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      tools: tools.map(toAnthropicTool),
      messages,
    });
    return fromAnthropicResponse(response);
  }

  async *stream(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    const messages = toAnthropicMessages(history);
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      tools: tools.map(toAnthropicTool),
      messages,
    });

    interface PendingTool {
      id: string;
      name: string;
      inputBuffer: string;
      input: Record<string, unknown>;
      parsed: boolean;
    }
    const pending: PendingTool[] = [];
    const completed: ToolCall[] = [];
    let currentToolId: string | null = null;
    let textBuffer = '';
    let stopReason: 'done' | 'tools' | 'limit' = 'done';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          const { id, name } = event.content_block;
          currentToolId = id;
          pending.push({ id, name, inputBuffer: '', input: {}, parsed: false });
          yield { type: 'tool_start', id, name };
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          textBuffer += delta.text;
          yield { type: 'text', text: delta.text };
        } else if (delta.type === 'input_json_delta' && currentToolId) {
          const tool = pending.find(t => t.id === currentToolId);
          if (tool) tool.inputBuffer += delta.partial_json;
          yield { type: 'tool_input', id: currentToolId, partial: delta.partial_json };
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolId) {
          const tool = pending.find(t => t.id === currentToolId);
          if (tool && !tool.parsed) {
            try { tool.input = JSON.parse(tool.inputBuffer); }
            catch { tool.input = { _raw: tool.inputBuffer }; }
            tool.parsed = true;
            const call: ToolCall = { id: tool.id, name: tool.name, input: tool.input };
            completed.push(call);
            yield { type: 'tool_end', call };
          }
          currentToolId = null;
        }
      } else if (event.type === 'message_delta') {
        if (event.delta.stop_reason === 'max_tokens') stopReason = 'limit';
        else if (event.delta.stop_reason === 'tool_use') stopReason = 'tools';
        if (event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens;
      } else if (event.type === 'message_start') {
        if (event.message?.usage?.input_tokens !== undefined) inputTokens = event.message.usage.input_tokens;
      }
    }

    yield {
      type: 'done',
      response: {
        text: textBuffer,
        toolCalls: completed,
        stopReason,
        usage: { inputTokens, outputTokens },
      },
    };
  }
}

// ── Conversion helpers ──────────────────────────────────────────────────────

function toAnthropicTool(t: ToolDefinition): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  };
}

function toAnthropicMessages(history: HistoryMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const msg of history) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const content: Anthropic.ContentBlock[] = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      out.push({ role: 'assistant', content });
    } else if (msg.role === 'tool_result') {
      out.push({
        role: 'user',
        content: msg.results.map(r => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: r.content,
          is_error: r.isError,
        })),
      });
    }
  }
  return out;
}

function fromAnthropicResponse(response: Anthropic.Message): LLMResponse {
  let text = '';
  const toolCalls: ToolCall[] = [];

  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
    }
  }

  const stopReason =
    response.stop_reason === 'tool_use' ? 'tools' :
    response.stop_reason === 'max_tokens' ? 'limit' : 'done';

  return {
    text, toolCalls, stopReason,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
