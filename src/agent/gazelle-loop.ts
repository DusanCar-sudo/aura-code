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

// ─────────────────────────────────────────────────────────────────────────────
// Gazelle loop — the conversational counterpart to runAgentLoop.
//
// It shares the provider layer and nothing else: no tools, no ProjectContext,
// no Archimedes, no verification gate. Read it top to bottom in one screen.
//
// Phase 3: it can hand off to coder mode (:coder, or by offering to switch when
// its own answer says it needs tools) and return a LoopOutcome the orchestrator
// in cli/index.ts uses to swap loops while carrying the conversation across.
// ─────────────────────────────────────────────────────────────────────────────

// Below this total token count nothing substantive happened, so the one
// session-end memory rewrite isn't worth its own model call — skip it.
const MEMORY_MIN_TOKENS = 200;

// Conversation almost never fills a context window; compact only when it truly
// does. This gate sits far above compactHistory's own first-fire (0.55) so the
// coding-agent compaction ladder never kicks in mid-chat.
const COMPACT_AT = 0.8;

// Part B — implicit escalation. We do NOT run a classifier model to decide if a
// turn needs tools (that would double Gazelle's cost every turn). Instead the
// system prompt already tells Gazelle to offer a switch when it needs tools; we
// just recognize that offer in the text it already generated. Near-free.
const ESCALATION_RE =
  /:coder\b|\bcoder mode\b|\bswitch to :?coder\b|\bcan'?t (?:read|run|open|access)\b|\bi'?d? (?:need|have) to (?:actually )?(?:look at|read|open|inspect|run|check|dig)\b|\bwant me to (?:switch|check|look at|read|open|run|dig|pull up)\b/i;

/** User accepted a yes/no offer (empty line = Enter = yes). */
const CONFIRM_RE = /^(y|yes|yeah|yep|sure|ok(?:ay)?|do it|go|please|pls)$/i;

/** Outcome of a mode loop — the orchestrator toggles to the other mode on 'switch'. */
export type LoopOutcome =
  | { action: 'exit'; history: HistoryMessage[] }
  | { action: 'switch'; history: HistoryMessage[]; carryMessage?: string };

// ── Shared line reader ────────────────────────────────────────────────────────
// One stdin, one reader — the gazelle and coder loops both pull from this so we
// never have two readline interfaces fighting over the same stream. Queues lines
// so a turn that streams for seconds never drops buffered/piped input.
export interface LineReader {
  nextLine: (promptFn?: () => void) => Promise<string | null>;
  close: () => void;
}

export function createLineReader(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  interactive: boolean,
): LineReader {
  const rl = readline.createInterface({ input, output });
  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const pump = (): void => { if (wake) { const w = wake; wake = null; w(); } };
  rl.on('line', l => { queue.push(l); pump(); });
  rl.on('close', () => { closed = true; pump(); });
  return {
    async nextLine(promptFn) {
      for (;;) {
        if (queue.length) return queue.shift()!;
        if (closed) return null;
        if (interactive && promptFn) promptFn();
        await new Promise<void>(res => { wake = res; });
      }
    },
    close() { rl.close(); },
  };
}

export interface GazelleLoopOptions {
  provider: LLMProvider;
  display: Display;
  /** Persist history here after every turn so :resume can pick it up later. */
  sessionPath?: string;
  /** Resume from / carry in a prior conversation's history. */
  initialHistory?: HistoryMessage[];
  /** A first message to answer immediately (CLI arg, or a carried-over turn). */
  firstMessage?: string;
  /** Shared input reader (orchestrator). If omitted, the loop makes its own. */
  reader?: LineReader;
  /** Overridable streams for tests / self-owned reader. Default: process stdin/stdout. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** When false, the orchestrator owns the one session-end memory write. Default true. */
  writeMemoryOnExit?: boolean;
}

export async function runGazelleLoop(opts: GazelleLoopOptions): Promise<LoopOutcome> {
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

  /** Answer one turn; returns the rendered text so the caller can inspect it
   *  for an escalation offer (Part B). */
  const respond = async (userText: string): Promise<string> => {
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
      return '';
    }
    display.streamEnd();

    history.push({ role: 'assistant', content: text });
    if (!reportedUsage) {
      totalInput += estimateContextTokens(system, history) - countText(text);
      totalOutput += countText(text);
    }
    await persist();
    return text;
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

  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const interactive = (input as NodeJS.ReadStream).isTTY === true;
  const ownReader = opts.reader ? null : createLineReader(input, output, interactive);
  const reader = opts.reader ?? ownReader!;
  const prompt = interactive ? () => output.write('\n  ▸ ') : undefined;

  // Finalize on exit: stats, one memory write (unless the orchestrator owns it).
  const finish = async (): Promise<LoopOutcome> => {
    if (ownReader) ownReader.close();
    printStats();
    if (opts.writeMemoryOnExit !== false && totalInput + totalOutput >= MEMORY_MIN_TOKENS) {
      await writeConversationalMemory(history, provider.model);
    }
    return { action: 'exit', history };
  };

  // Escalation-offer state: when set, the next line is treated as a y/n answer
  // to "switch to coder?", and the stored string is the message coder answers.
  let pendingOfferFor: string | null = null;

  // Answer an initial message (CLI arg, or a turn carried over from coder mode).
  if (opts.firstMessage && opts.firstMessage.trim()) {
    const first = opts.firstMessage.trim();
    const text = await respond(first);
    if (ESCALATION_RE.test(text)) { offerSwitch(output, interactive); pendingOfferFor = first; }
  }

  for (;;) {
    const line = await reader.nextLine(prompt);
    if (line === null) return finish();               // EOF / Ctrl-D
    const msg = line.trim();

    // Resolve a pending escalation offer first (empty line = Enter = accept).
    if (pendingOfferFor !== null) {
      const offered = pendingOfferFor;
      pendingOfferFor = null;
      if (msg === '' || CONFIRM_RE.test(msg)) {
        return { action: 'switch', history, carryMessage: offered };
      }
      // Not an acceptance — fall through and handle msg as normal input.
    }

    if (!msg) continue;
    if (msg === ':exit' || msg === ':quit' || msg === ':q' || msg === '/exit' || msg === '/quit') {
      return finish();
    }
    if (msg === ':coder') return { action: 'switch', history };
    if (msg === ':gazelle') { display.warning('Already in conversational (Gazelle) mode.'); continue; }
    if (msg === ':stats' || msg === '/stats') { printStats(); continue; }

    const text = await respond(msg);
    if (ESCALATION_RE.test(text)) {
      offerSwitch(output, interactive);
      pendingOfferFor = msg;
    }
  }
}

/** Print the one-keypress switch hint (interactive only; piped runs read the
 *  offer straight from the model's text). */
function offerSwitch(output: NodeJS.WritableStream, interactive: boolean): void {
  if (interactive) {
    output.write('\n  ↳ press Enter (or y) to switch to coder mode, or keep typing\n');
  }
}
