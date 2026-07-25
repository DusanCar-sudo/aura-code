import * as readline from 'readline';
import type { LLMProvider, HistoryMessage } from '../providers/types.js';
import type { Display } from '../cli/display.js';
import { buildGazellePrompt } from './gazelle-prompt.js';
import { loadGazelleMemory } from './unified-memory.js';
import { sessionStore } from './session-store.js';
import { compactHistory, estimateContextTokens, countText } from './compactor.js';
import { getContextWindow } from '../providers/factory.js';
import { formatProviderError } from './loop.js';
import { writeConversationalMemory } from './gazelle-memory-writer.js';

// Below this total token count nothing substantive happened, so the one
// session-end memory rewrite isn't worth its own model call — skip it.
const MEMORY_MIN_TOKENS = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Gazelle loop — the conversational counterpart to runAgentLoop.
//
// It shares the provider layer and nothing else: no tools, no ProjectContext,
// no Archimedes, no verification gate, no compaction ladder. Read it top to
// bottom in one screen. If it grows past ~200 lines, something coding-agent-
// shaped has leaked in — cut it back.
// ─────────────────────────────────────────────────────────────────────────────

export interface GazelleLoopOptions {
  provider: LLMProvider;
  display: Display;
  /** Persist history here after every turn so :resume can pick it up later. */
  sessionPath?: string;
  /** Resume from a prior conversation's history. */
  initialHistory?: HistoryMessage[];
  /** A first message to answer immediately (e.g. a CLI positional argument). */
  firstMessage?: string;
  /** Overridable streams for tests. Default: process stdin/stdout. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

// Conversation almost never fills a context window; compact only when it truly
// does. This gate sits far above compactHistory's own first-fire (0.55) so the
// coding-agent compaction ladder never kicks in mid-chat — we only borrow the
// one compaction pass, and only at the very top of the window.
const COMPACT_AT = 0.8;

export async function runGazelleLoop(opts: GazelleLoopOptions): Promise<void> {
  const { provider, display } = opts;
  const system = buildGazellePrompt(loadGazelleMemory());
  const history: HistoryMessage[] = [...(opts.initialHistory ?? [])];

  let totalInput = 0;
  let totalOutput = 0;

  const persist = async (): Promise<void> => {
    if (!opts.sessionPath) return;
    try { await sessionStore.save(opts.sessionPath, history); }
    catch { /* persistence is best-effort */ }
  };

  // Borrow the one compaction pass only when the window is genuinely full.
  const maybeCompact = (): void => {
    const window = getContextWindow(provider.model) ?? 32_000;
    const estimated = estimateContextTokens(system, history);
    if (estimated <= window * COMPACT_AT) return;
    if (compactHistory(history, estimated, provider.model)) {
      display.warning(
        `Context compacted: ${estimated.toLocaleString()} → ` +
        `${estimateContextTokens(system, history).toLocaleString()} tokens`,
      );
    }
  };

  const respond = async (userText: string): Promise<void> => {
    history.push({ role: 'user', content: userText });
    maybeCompact();
    display.agentThinking();

    let text = '';
    let reportedUsage = false;
    try {
      // The empty tools array is the whole feature: no ~4 KB schema per turn.
      for await (const chunk of provider.stream(system, history, [])) {
        if (chunk.type === 'text') {
          display.streamText(chunk.text);
          text += chunk.text;
        } else if (chunk.type === 'done') {
          const u = chunk.response.usage;
          if (u) {
            totalInput += u.inputTokens ?? 0;
            totalOutput += u.outputTokens ?? 0;
            reportedUsage = true;
          }
        }
      }
    } catch (e) {
      display.streamEnd();
      display.error(`Provider error: ${formatProviderError(e)}`);
      return;
    }
    display.streamEnd();

    // Some Ollama builds omit usage on a turn; estimate so the token report is
    // never silently short (estimateContextTokens now includes this response).
    history.push({ role: 'assistant', content: text });
    if (!reportedUsage) {
      totalInput += estimateContextTokens(system, history) - countText(text);
      totalOutput += countText(text);
    }
    await persist();
  };

  const messageCount = (): number => history.filter(m => m.role === 'user').length;
  const printStats = (): void => {
    const total = totalInput + totalOutput;
    display.warning(
      `Gazelle session: ${total.toLocaleString()} tokens ` +
      `(${totalInput.toLocaleString()} in · ${totalOutput.toLocaleString()} out) ` +
      `over ${messageCount()} message(s)`,
    );
  };

  // Answer an initial message (CLI positional arg) before entering the REPL.
  if (opts.firstMessage && opts.firstMessage.trim()) {
    await respond(opts.firstMessage.trim());
  }

  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const interactive = (input as NodeJS.ReadStream).isTTY === true;
  const rl = readline.createInterface({ input, output });

  // Queue lines as they arrive. A turn can stream for seconds; without a queue,
  // any input that lands during that turn (buffered piped questions, a fast
  // typer) is dropped and the loop then sees EOF and exits early. nextLine()
  // hands back the oldest queued line, or null at EOF (Ctrl-D / exhausted pipe).
  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const pump = (): void => { if (wake) { const w = wake; wake = null; w(); } };
  rl.on('line', l => { queue.push(l); pump(); });
  rl.on('close', () => { closed = true; pump(); });

  const nextLine = async (): Promise<string | null> => {
    for (;;) {
      if (queue.length) return queue.shift()!;
      if (closed) return null;
      if (interactive) output.write('\n  ▸ ');
      await new Promise<void>(res => { wake = res; });
    }
  };

  for (;;) {
    const line = await nextLine();
    if (line === null) break;                       // EOF / Ctrl-D
    const msg = line.trim();
    if (!msg) continue;
    if (msg === ':exit' || msg === ':quit' || msg === '/exit' || msg === '/quit') break;
    if (msg === ':stats' || msg === '/stats') { printStats(); continue; }
    if (msg === ':coder' || msg === ':gazelle') {
      display.warning('Runtime mode switching is Phase 3 — restart without --gazelle for the coder path.');
      continue;
    }
    await respond(msg);
  }

  rl.close();
  printStats();

  // Session-end conversational memory: one cheap rewrite so the next session
  // opens already knowing where things stand. Awaited (not fire-and-forget)
  // so it finishes before the process exits, but only when enough happened.
  if (totalInput + totalOutput >= MEMORY_MIN_TOKENS) {
    await writeConversationalMemory(history, provider.model);
  }
}
