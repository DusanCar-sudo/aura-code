import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from '../util/env.js';
import { withIdleTimeout, streamIdleMs, isStreamStalled } from './stream-timeout.js';
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

  constructor(config: ProviderConfig, providerName?: string) {
    this.model = config.model;
    // 8192, not 8096 — the latter was a typo for the real API ceiling and
    // silently cost 96 tokens of output headroom on every call.
    this.maxTokens = config.maxTokens ?? 8192;
    if (providerName) this.name = providerName;
    this.client = new Anthropic({
      apiKey: config.apiKey ?? getApiKey('ANTHROPIC_API_KEY'),
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
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
      system: toCachedSystem(system),
      tools: toCachedTools(tools),
      messages,
    });
    return fromAnthropicResponse(response);
  }

  /**
   * Retried once on a stall, and only when nothing has reached the consumer —
   * see the note on OpenAICompatibleProvider.stream. Re-running after text has
   * been yielded would duplicate the response.
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
    yield* this.streamOnce(system, history, tools);
  }

  private async *streamOnce(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    const messages = toAnthropicMessages(history);
    // Lets the idle guard tear down the socket instead of leaking it.
    const controller = new AbortController();
    const rawStream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      system: toCachedSystem(system),
      tools: toCachedTools(tools),
      messages,
    }, { signal: controller.signal });
    const stream = withIdleTimeout(rawStream, {
      idleMs: streamIdleMs(),
      onStall: () => controller.abort(),
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
    let cacheRead = 0;
    let cacheCreation = 0;

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
        if (event.message?.usage) {
          const u = event.message.usage as Anthropic.Usage & {
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
          cacheRead = u.cache_read_input_tokens ?? 0;
          cacheCreation = u.cache_creation_input_tokens ?? 0;
          if (process.env.AURA_DEBUG_CACHE) {
            console.error(`[cache] creation=${cacheCreation} read=${cacheRead} input=${u.input_tokens}`);
          }
        }
      }
    }

    yield {
      type: 'done',
      response: {
        text: textBuffer,
        toolCalls: completed,
        stopReason,
        usage: {
          inputTokens, outputTokens,
          ...(cacheRead > 0 ? { cachedTokens: cacheRead } : {}),
          ...(cacheCreation > 0 ? { cacheCreationTokens: cacheCreation } : {}),
        },
      },
    };
  }
}

// ── Conversion helpers ──────────────────────────────────────────────────────

// cache_control is GA on the Messages API but missing from SDK 0.32.1's
// non-beta types, hence the intersection casts below.
type CacheControl = { cache_control: { type: 'ephemeral' } };

// System prompt and tool definitions are static per session (built once in
// loop.ts; compaction only rewrites history), so mark both as cache
// breakpoints: everything up to and including a marked block is cached.
export function toCachedSystem(system: string): Anthropic.TextBlockParam[] {
  return [{
    type: 'text',
    text: system,
    cache_control: { type: 'ephemeral' },
  } as Anthropic.TextBlockParam & CacheControl];
}

export function toCachedTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  const out = tools.map(toAnthropicTool);
  if (out.length > 0) {
    out[out.length - 1] = {
      ...out[out.length - 1],
      cache_control: { type: 'ephemeral' },
    } as Anthropic.Tool & CacheControl;
  }
  return out;
}

function toAnthropicTool(t: ToolDefinition): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  };
}

export function toAnthropicMessages(history: HistoryMessage[]): Anthropic.MessageParam[] {
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

  // Cache breakpoints go on *stable semantic anchors*, not tail-relative
  // positions.
  //
  // This used to mark every 4th message counting back from the end. Because
  // history grows by a variable number of messages per turn (one user, one
  // assistant, then one tool_result per tool call), those positions landed on
  // a different absolute message almost every call. Anthropic still served
  // the longest matching prefix, so reads were not destroyed — but each call
  // wrote a *new* cache entry at a position no later call would reuse, paying
  // the 1.25x cache-write premium for nothing.
  //
  // Anchors here are chosen to have byte-identical prefixes across turns:
  //   - history[0]: the original task. Never rewritten, not even by
  //     compaction (both strategies preserve it as the anchor), so this is
  //     the deepest prefix that is guaranteed stable for the whole session.
  //   - the recap / fact-log block: everything before it has already been
  //     collapsed, and both strategies emit it with a fixed marker prefix.
  //     The tiered strategy is append-only by design, which is exactly the
  //     shape a prefix cache wants.
  //
  // Anthropic allows 4 cache_control blocks per request; system and tools
  // take one each, leaving two — which is what the two anchors below use.
  const anchors: number[] = [];
  if (out.length > 0) anchors.push(0);
  for (let i = out.length - 1; i >= 1; i--) {
    if (isCompactionAnchor(out[i])) { anchors.push(i); break; }
  }

  for (const i of anchors) {
    const msg = out[i];
    if (typeof msg.content === 'string') {
      msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam & CacheControl];
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlock = msg.content[msg.content.length - 1] as any;
      lastBlock.cache_control = { type: 'ephemeral' };
    }
  }

  return out;
}

/** Markers emitted by the two compaction strategies (compactor.ts /
 *  tiered-context.ts). Matched by prefix so the generation/count suffix,
 *  which does change, never affects anchor detection. */
const COMPACTION_MARKERS = ['[Earlier conversation compacted', '[Context fact log'];

function isCompactionAnchor(msg: Anthropic.MessageParam): boolean {
  if (msg.role !== 'assistant') return false;
  const text = typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content)
      ? (msg.content.find(b => (b as { type?: string }).type === 'text') as { text?: string } | undefined)?.text ?? ''
      : '';
  return COMPACTION_MARKERS.some(m => text.startsWith(m));
}

export function fromAnthropicResponse(response: Anthropic.Message): LLMResponse {
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

  const raw = response.usage as Anthropic.Usage & {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheCreation = raw.cache_creation_input_tokens ?? 0;

  if (process.env.AURA_DEBUG_CACHE && (cacheRead > 0 || cacheCreation > 0)) {
    console.error(`[cache] creation=${cacheCreation} read=${cacheRead} input=${response.usage.input_tokens}`);
  }

  return {
    text, toolCalls, stopReason,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(cacheRead > 0 ? { cachedTokens: cacheRead } : {}),
      ...(cacheCreation > 0 ? { cacheCreationTokens: cacheCreation } : {}),
    },
  };
}
