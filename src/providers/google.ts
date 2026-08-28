import { GoogleGenerativeAI, type Part, type FunctionDeclaration } from '@google/generative-ai';
import { getApiKey } from '../util/env.js';
import type {
  LLMProvider, ProviderConfig, ToolDefinition,
  HistoryMessage, LLMResponse, StreamChunk, ToolCall,
} from './types.js';

export class GoogleProvider implements LLMProvider {
  name = 'Google';
  supportsTools = true;
  model: string;

  private client: GoogleGenerativeAI;
  private maxTokens: number;
  /**
   * Request timeout. The SDK defaults to none, so a Gemini endpoint under load
   * — the 503 "This model is currently experiencing high demand" state — can
   * leave a call outstanding indefinitely instead of failing into the retry and
   * fallback machinery, which is what makes Google look hung while every other
   * provider is fine. Override with GOOGLE_TIMEOUT_MS.
   */
  private timeoutMs: number;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 8192;
    this.timeoutMs = Number(process.env.GOOGLE_TIMEOUT_MS) || 120_000;
    this.client = new GoogleGenerativeAI(
      config.apiKey ?? getApiKey('GOOGLE_API_KEY', 'GEMINI_API_KEY') ?? '',
    );
  }

  /** Model handle shared by complete() and stream() — same params, same timeout. */
  private modelFor(system: string, tools: ToolDefinition[]) {
    return this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: system,
      tools: tools.length > 0 ? [{ functionDeclarations: tools.map(toGoogleTool) }] : undefined,
      generationConfig: { maxOutputTokens: this.maxTokens },
    }, { timeout: this.timeoutMs });
  }

  async complete(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): Promise<LLMResponse> {
    const genModel = this.modelFor(system, tools);

    const { contents } = toGoogleHistory(history);
    const result = await genModel.generateContent({ contents });

    return fromGoogleResponse(result.response);
  }

  async *stream(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamChunk> {
    const genModel = this.modelFor(system, tools);

    const { contents } = toGoogleHistory(history);
    const result = await genModel.generateContentStream({ contents });

    let textBuffer = '';
    const toolCalls: ToolCall[] = [];
    const rawParts: Part[] = [];

    for await (const chunk of result.stream) {
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        rawParts.push(part);
        if (part.text) {
          textBuffer += part.text;
          yield { type: 'text', text: part.text };
        }
        if (part.functionCall) {
          const id = `gc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const call: ToolCall = {
            id,
            name: part.functionCall.name,
            input: part.functionCall.args as Record<string, unknown>,
          };
          toolCalls.push(call);
          yield { type: 'tool_start', id, name: call.name };
          yield { type: 'tool_end', call };
        }
      }
    }

    const finalResponse = await result.response.catch(() => null);
    const meta = finalResponse?.usageMetadata;
    const usage = meta ? {
      inputTokens: meta.promptTokenCount ?? 0,
      outputTokens: meta.candidatesTokenCount ?? 0,
    } : undefined;

    const stopReason = toolCalls.length > 0 ? 'tools' : 'done';
    yield {
      type: 'done',
      response: { text: textBuffer, toolCalls, googleParts: rawParts, stopReason, usage } as LLMResponse,
    };
  }
}

// ── Conversion helpers ──────────────────────────────────────────────────────

function toGoogleTool(t: ToolDefinition): FunctionDeclaration {
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters as FunctionDeclaration['parameters'],
  };
}

interface GoogleContent { role: 'user' | 'model'; parts: Part[] }

function toGoogleHistory(history: HistoryMessage[]): { contents: GoogleContent[] } {
  const contents: GoogleContent[] = [];

  for (const msg of history) {
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] });
    } else if (msg.role === 'assistant') {
      const parts: Part[] = [];
      if ((msg as any).googleParts && (msg as any).googleParts.length > 0) {
        parts.push(...(msg as any).googleParts);
      } else {
        if (msg.content) parts.push({ text: msg.content });
        for (const tc of msg.toolCalls ?? []) {
          parts.push({ functionCall: { name: tc.name, args: tc.input } });
        }
      }
      contents.push({ role: 'model', parts });
    } else if (msg.role === 'tool_result') {
      contents.push({
        role: 'user',
        parts: msg.results.map(r => ({
          functionResponse: { name: r.name, response: { result: r.content } },
        })),
      });
    }
  }

  return { contents };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** Exported so recorded wire fixtures can be replayed through the real parser. */
export function fromGoogleResponse(response: any): LLMResponse & { googleParts?: Part[] } {
  const candidates = response?.candidates ?? [];
  const parts: Part[] = candidates[0]?.content?.parts ?? [];

  let text = '';
  const toolCalls: ToolCall[] = [];

  for (const part of parts) {
    if (part.text) text += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: `gc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: part.functionCall.name,
        input: part.functionCall.args as Record<string, unknown>,
      });
    }
  }

  const meta = response?.usageMetadata;
  return {
    text,
    toolCalls,
    googleParts: parts,
    stopReason: toolCalls.length > 0 ? 'tools' : 'done',
    usage: meta ? {
      inputTokens: meta.promptTokenCount ?? 0,
      outputTokens: meta.candidatesTokenCount ?? 0,
    } : undefined,
  };
}
