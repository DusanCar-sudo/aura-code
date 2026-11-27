// ─────────────────────────────────────────────────────────────────────────────
// Aura Inference Gateway — an OpenAI-compatible endpoint over the provider
// layer. Phase 1 of the inference roadmap: anything that speaks the OpenAI
// chat-completions wire format (a script, another tool, an app, a phone) can
// now call ANY model aura-code can reach, through one URL and one token.
//
// Deliberately mounted *behind* the server's auth gate, so the same
// bearer/session token that protects every other route protects inference.
// ─────────────────────────────────────────────────────────────────────────────

import type express from 'express';
import type {
  HistoryMessage,
  LLMProvider,
  ProviderConfig,
} from '../providers/types.js';

/** How the gateway obtains a provider for a model string. Injectable so
 *  tests can pass a stub instead of the real factory. */
export type ProviderFactory = (config: ProviderConfig) => LLMProvider;

export interface InferenceRouteOptions {
  /** What `aura-1` and an omitted `model` resolve to. */
  defaultModel: string;
  create: ProviderFactory;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI wire types (only the fields we accept or emit)
// ─────────────────────────────────────────────────────────────────────────────

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
}

interface ChatCompletionRequest {
  model?: string;
  messages?: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a caller-supplied model id to a provider config model.
 *   undefined / "aura-1"  → default model (the branded virtual model)
 *   "vendor/model"        → passes through (factory already routes prefixes)
 *   anything else         → passes through
 */
export function resolveGatewayModel(requested: string | undefined, defaultModel: string): string {
  const trimmed = (requested ?? '').trim();
  if (!trimmed || trimmed === 'aura-1' || trimmed === 'aura/aura-1') return defaultModel;
  return trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire-format translation
// ─────────────────────────────────────────────────────────────────────────────

export function toInternalMessages(messages: OpenAIMessage[]): {
  system: string;
  history: HistoryMessage[];
} {
  const systemParts: string[] = [];
  const history: HistoryMessage[] = [];

  for (const msg of messages) {
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (msg.role === 'system') {
      systemParts.push(text);
    } else if (msg.role === 'user') {
      history.push({ role: 'user', content: text });
    } else if (msg.role === 'assistant') {
      history.push({ role: 'assistant', content: text });
    } else {
      // OpenAI `tool` results arrive as plain text here in phase 1 — the
      // gateway does not expose aura's tool loop, only single completions.
      history.push({ role: 'user', content: text });
    }
  }

  return { system: systemParts.join('\n\n'), history };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

export function registerInferenceRoutes(app: express.Express, opts: InferenceRouteOptions): void {
  const jsonError = (res: express.Response, status: number, message: string): void => {
    res.status(status).json({ error: { message, type: 'aura_inference_error' } });
  };

  // Model list — small and honest in phase 1: the virtual model plus whatever
  // the default resolves to. Discovery grows in phase 2.
  app.get('/v1/models', (_req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const ids = Array.from(new Set(['aura-1', opts.defaultModel]));
    res.json({
      object: 'list',
      data: ids.map(id => ({
        id, object: 'model', created: now, owned_by: 'aura',
      })),
    });
  });

  app.post('/v1/chat/completions', (req, res) => {
    const body = (req.body ?? {}) as ChatCompletionRequest;

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      jsonError(res, 400, 'messages must be a non-empty array.');
      return;
    }
    if (body.stream) {
      // Phase 1 serves non-streaming only; say so instead of silently
      // degrading a client that is waiting for SSE frames.
      jsonError(res, 400, 'stream=true is not supported yet; call with stream unset or false.');
      return;
    }

    const model = resolveGatewayModel(body.model, opts.defaultModel);
    const { system, history } = toInternalMessages(body.messages);

    let provider: LLMProvider;
    try {
      provider = opts.create({
        model,
        maxTokens: body.max_tokens,
        temperature: body.temperature,
      });
    } catch (err) {
      jsonError(res, 400, `Unknown or unconfigured model "${model}": ${(err as Error).message}`);
      return;
    }

    provider.complete(system, history, [])
      .then(completion => {
        res.json({
          id: `chatcmpl-aura-${Date.now().toString(36)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: completion.text },
            finish_reason: completion.stopReason === 'tools' ? 'tool_calls' : 'stop',
          }],
          usage: completion.usage
            ? {
                prompt_tokens: completion.usage.inputTokens,
                completion_tokens: completion.usage.outputTokens,
                total_tokens: completion.usage.inputTokens + completion.usage.outputTokens,
              }
            : undefined,
          aura: { provider: provider.name },
        });
      })
      .catch((err: Error) => {
        jsonError(res, 502, `Upstream model "${model}" failed: ${err.message}`);
      });
  });
}
