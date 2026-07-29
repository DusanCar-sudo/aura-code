import type { LLMProvider, HistoryMessage } from '../providers/types.js';
import type { Display } from '../cli/display.js';
import { buildGazellePrompt } from './gazelle-prompt.js';
import { loadGazelleMemory } from './unified-memory.js';
import { sessionStore } from './session-store.js';
import { compactHistory, estimateContextTokens, countText } from './compactor.js';
import { getContextWindow } from '../providers/factory.js';
import { formatProviderError } from './loop.js';

// ─────────────────────────────────────────────────────────────────────────────
// Gazelle's turn machinery, with no opinion about where input comes from.
//
// This used to live inside runGazelleLoop, which meant lean conversational mode
// was only reachable from a readline-driven stdin loop — so the TUI REPL, which
// owns stdin in raw mode and cannot host a second reader, could not offer
// :gazelle at all even though :help advertised it. Everything that makes a
// Gazelle turn *a Gazelle turn* is here (lean prompt, empty tool array,
// conversation-only compaction, escalation detection); the reader-driven loop
// and the TUI both drive it through respond().
// ─────────────────────────────────────────────────────────────────────────────

/** Conversation almost never fills a context window; compact only when it truly
 *  does. This gate sits far above compactHistory's own first-fire (0.55) so the
 *  coding-agent compaction ladder never kicks in mid-chat. */
const COMPACT_AT = 0.8;

// Part B — implicit escalation. We do NOT run a classifier model to decide if a
// turn needs tools (that would double Gazelle's cost every turn). Instead the
// system prompt already tells Gazelle to offer a switch when it needs tools; we
// just recognize that offer in the text it already generated. Near-free.
export const ESCALATION_RE =
  /:coder\b|\bcoder mode\b|\bswitch to :?coder\b|\bcan'?t (?:read|run|open|access)\b|\bi'?d? (?:need|have) to (?:actually )?(?:look at|read|open|inspect|run|check|dig)\b|\bwant me to (?:switch|check|look at|read|open|run|dig|pull up)\b/i;

export interface GazelleChatOptions {
  /** A provider, or a thunk resolving one per turn — the TUI needs the thunk so
   *  a `:model` switch mid-conversation takes effect on the next reply. */
  provider: LLMProvider | (() => LLMProvider);
  display: Display;
  /** Carried-in conversation. Copied, not adopted: callers keep their own array. */
  initialHistory?: HistoryMessage[];
  /** Persist history here after every turn so :resume can pick it up later. */
  sessionPath?: string;
}

/** One finished exchange. `needsTools` is the escalation offer Gazelle already
 *  made in its own words — the caller decides what to do about it. */
export interface GazelleTurn {
  text: string;
  needsTools: boolean;
  inputTokens: number;
  outputTokens: number;
  /** The provider call failed; the error was already shown. */
  failed: boolean;
}

export interface GazelleChat {
  /** Live conversation — grows with every respond(). */
  readonly history: HistoryMessage[];
  respond(userText: string): Promise<GazelleTurn>;
  totals(): { inputTokens: number; outputTokens: number; messages: number };
  /** One-line token summary, as :stats and session end print it. */
  statsLine(): string;
}

export function createGazelleChat(opts: GazelleChatOptions): GazelleChat {
  const { display } = opts;
  const resolveProvider: () => LLMProvider =
    typeof opts.provider === 'function' ? opts.provider : () => opts.provider as LLMProvider;
  const system = buildGazellePrompt(loadGazelleMemory());
  const history: HistoryMessage[] = [...(opts.initialHistory ?? [])];

  let totalInput = 0;
  let totalOutput = 0;

  const persist = async (): Promise<void> => {
    if (!opts.sessionPath) return;
    try { await sessionStore.save(opts.sessionPath, history); }
    catch { /* persistence is best-effort */ }
  };

  const maybeCompact = (model: string): void => {
    const window = getContextWindow(model) ?? 32_000;
    const estimated = estimateContextTokens(system, history);
    if (estimated <= window * COMPACT_AT) return;
    if (compactHistory(history, estimated, model)) {
      display.warning(
        `Context compacted: ${estimated.toLocaleString()} → ` +
        `${estimateContextTokens(system, history).toLocaleString()} tokens`,
      );
    }
  };

  const respond = async (userText: string): Promise<GazelleTurn> => {
    const provider = resolveProvider();
    history.push({ role: 'user', content: userText });
    maybeCompact(provider.model);
    display.agentThinking();

    let text = '';
    let reportedUsage = false;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      // The empty tools array is the whole feature: no ~4 KB schema per turn.
      for await (const chunk of provider.stream(system, history, [])) {
        if (chunk.type === 'text') {
          display.streamText(chunk.text);
          text += chunk.text;
        } else if (chunk.type === 'done') {
          const u = chunk.response.usage;
          if (u) {
            inputTokens = u.inputTokens ?? 0;
            outputTokens = u.outputTokens ?? 0;
            reportedUsage = true;
          }
        }
      }
    } catch (e) {
      display.streamEnd();
      display.error(`Provider error: ${formatProviderError(e)}`);
      return { text: '', needsTools: false, inputTokens: 0, outputTokens: 0, failed: true };
    }
    display.streamEnd();

    history.push({ role: 'assistant', content: text });
    if (!reportedUsage) {
      inputTokens = estimateContextTokens(system, history) - countText(text);
      outputTokens = countText(text);
    }
    totalInput += inputTokens;
    totalOutput += outputTokens;
    await persist();
    return { text, needsTools: ESCALATION_RE.test(text), inputTokens, outputTokens, failed: false };
  };

  const totals = () => ({
    inputTokens: totalInput,
    outputTokens: totalOutput,
    messages: history.filter(m => m.role === 'user').length,
  });

  const statsLine = (): string => {
    const t = totals();
    return `Gazelle session: ${(t.inputTokens + t.outputTokens).toLocaleString()} tokens ` +
      `(${t.inputTokens.toLocaleString()} in · ${t.outputTokens.toLocaleString()} out) ` +
      `over ${t.messages} message(s)`;
  };

  return { history, respond, totals, statsLine };
}
