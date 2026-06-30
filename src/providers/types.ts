// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions  (provider-agnostic JSON Schema)
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
  };
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
  default?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool calls (what the model wants to do)
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation history (the loop maintains this)
// ─────────────────────────────────────────────────────────────────────────────

export type HistoryMessage =
  | { role: 'user';       content: string }
  | { role: 'assistant';  content: string; toolCalls?: ToolCall[] }
  | { role: 'tool_result'; results: ToolResult[] };

// ─────────────────────────────────────────────────────────────────────────────
// LLM response (what every adapter returns to the loop)
// ─────────────────────────────────────────────────────────────────────────────

export interface LLMResponse {
  text: string;                  // Any prose the model wrote (may be empty)
  toolCalls: ToolCall[];         // Tool invocations (may be empty)
  stopReason: 'done' | 'tools' | 'limit';
  usage?: { inputTokens: number; outputTokens: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming chunk (emitted per token for live display)
// ─────────────────────────────────────────────────────────────────────────────

export type StreamChunk =
  | { type: 'text';       text: string }
  | { type: 'tool_start'; name: string; id: string }
  | { type: 'tool_input'; id: string; partial: string }
  | { type: 'tool_end';   call: ToolCall }
  | { type: 'done';       response: LLMResponse };

// ─────────────────────────────────────────────────────────────────────────────
// The provider interface — implement this to add a new model/provider
// ─────────────────────────────────────────────────────────────────────────────

export interface LLMProvider {
  /** Provider name for display (e.g. "Anthropic", "OpenAI") */
  name: string;

  /** Model identifier being used */
  model: string;

  /** One-shot completion (no streaming) */
  complete(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): Promise<LLMResponse>;

  /** Streaming completion — yields chunks as the model generates */
  stream(
    system: string,
    history: HistoryMessage[],
    tools: ToolDefinition[],
  ): AsyncGenerator<StreamChunk>;

  /** Whether this provider supports tool use */
  supportsTools: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider config (from CLI args or .aura.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  model: string;
  apiKey?: string;      // Overrides env var
  baseUrl?: string;     // For custom endpoints (Ollama, LM Studio, proxies)
  maxTokens?: number;
  temperature?: number;
}
