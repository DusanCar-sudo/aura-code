import * as readline from 'readline';
import type { HistoryMessage } from '../providers/types.js';
import { createGazelleChat, type GazelleChatOptions } from './gazelle-chat.js';
import { writeConversationalMemory } from './gazelle-memory-writer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Gazelle loop — the conversational counterpart to runAgentLoop.
//
// It shares the provider layer and nothing else: no tools, no ProjectContext,
// no Archimedes, no verification gate. The turn itself lives in gazelle-chat.ts
// (the TUI REPL drives the same machinery without a reader); this file is the
// stdin loop around it.
//
// Phase 3: it can hand off to coder mode (:coder, or by offering to switch when
// its own answer says it needs tools) and return a LoopOutcome the orchestrator
// in cli/index.ts uses to swap loops while carrying the conversation across.
// ─────────────────────────────────────────────────────────────────────────────

// Below this total token count nothing substantive happened, so the one
// session-end memory rewrite isn't worth its own model call — skip it.
const MEMORY_MIN_TOKENS = 200;

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

export interface GazelleLoopOptions extends GazelleChatOptions {
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
  const { display } = opts;
  const chat = createGazelleChat(opts);
  const history = chat.history;
  const printStats = (): void => display.warning(chat.statsLine());

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
    const { inputTokens, outputTokens } = chat.totals();
    if (opts.writeMemoryOnExit !== false && inputTokens + outputTokens >= MEMORY_MIN_TOKENS) {
      const provider = typeof opts.provider === 'function' ? opts.provider() : opts.provider;
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
    const turn = await chat.respond(first);
    if (turn.needsTools) { offerSwitch(output, interactive); pendingOfferFor = first; }
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

    const turn = await chat.respond(msg);
    if (turn.needsTools) {
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
