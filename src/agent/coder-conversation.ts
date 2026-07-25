import type { LLMProvider, HistoryMessage } from '../providers/types.js';
import type { Display } from '../cli/display.js';
import type { ProjectContext } from './context.js';
import type { PermissionSystem } from '../safety/permissions.js';
import { runAgentLoop } from './loop.js';
import type { LineReader, LoopOutcome } from './gazelle-loop.js';

// ─────────────────────────────────────────────────────────────────────────────
// Coder conversational loop — the heavy path, driven turn-by-turn.
//
// Phase 3's other half: once Gazelle hands off (:coder, or an accepted switch
// offer), this reads a line, runs the full tool-using agent loop for it, and
// keeps the conversation going. It carries history in/out and returns a
// LoopOutcome so the orchestrator can swap back to Gazelle. It deliberately
// reuses runAgentLoop rather than reimplementing the agent — this file is just
// the REPL shell around it.
// ─────────────────────────────────────────────────────────────────────────────

/** A finished coder task followed by a short, non-technical line usually means
 *  the user is done with tools and back to chatting. Used only to *offer* a
 *  switch back — never to switch silently. */
const CODEY_RE =
  /\b(file|code|read|run|tests?|git|build|fix|bug|error|log|commit|refactor|implement|function|class|npm|install|debug|deploy|diff|stack|trace|check the|look at|open the|why (?:does|is|isn't)|patch)\b/i;

const CONFIRM_RE = /^(y|yes|yeah|yep|sure|ok(?:ay)?|do it|go|please|pls)$/i;

function looksConversational(msg: string): boolean {
  if (CODEY_RE.test(msg)) return false;
  return msg.length < 120; // short and non-technical → probably just talking
}

export interface CoderConversationOptions {
  provider: LLMProvider;
  ctx: ProjectContext;
  permissions: PermissionSystem;
  display: Display;
  reader: LineReader;
  output: NodeJS.WritableStream;
  interactive: boolean;
  initialHistory?: HistoryMessage[];
  /** First task to run immediately (e.g. the question that triggered the switch). */
  firstMessage?: string;
  maxTurns?: number;
  sessionPath?: string;
  spawnConfig?: { apiKey?: string; baseUrl?: string };
}

export async function runCoderConversation(opts: CoderConversationOptions): Promise<LoopOutcome> {
  const { provider, ctx, permissions, display, reader, output, interactive } = opts;
  let history: HistoryMessage[] = [...(opts.initialHistory ?? [])];

  const runTask = async (task: string): Promise<void> => {
    const result = await runAgentLoop({
      provider, task, context: ctx, permissions, display,
      initialHistory: history,
      maxTurns: opts.maxTurns,
      sessionPath: opts.sessionPath,
      spawnConfig: opts.spawnConfig,
    });
    history = result.history;
    display.summary(result.summary, result.turns, result.toolCallCount);
  };

  const prompt = interactive ? () => output.write('\n  ⚒ ') : undefined;

  // True right after a task finishes — enables the Part C "back to talking?" offer.
  let taskJustCompleted = false;
  // When set, the next line answers a pending "switch back to Gazelle?" offer,
  // and the stored string is the conversational line Gazelle should answer.
  let pendingReturnFor: string | null = null;

  if (opts.firstMessage && opts.firstMessage.trim()) {
    await runTask(opts.firstMessage.trim());
    taskJustCompleted = true;
  }

  for (;;) {
    const line = await reader.nextLine(prompt);
    if (line === null) return { action: 'exit', history };
    const msg = line.trim();

    // Resolve a pending return-to-Gazelle offer (empty line = Enter = accept).
    if (pendingReturnFor !== null) {
      const carried = pendingReturnFor;
      pendingReturnFor = null;
      if (msg === '' || CONFIRM_RE.test(msg)) {
        return { action: 'switch', history, carryMessage: carried };
      }
      // Declined — treat the stored line as a coder task after all.
      await runTask(carried);
      taskJustCompleted = true;
      continue;
    }

    if (!msg) continue;
    if (msg === ':gazelle') return { action: 'switch', history };
    if (msg === ':coder') { display.warning('Already in coder mode.'); continue; }
    if (msg === ':exit' || msg === ':quit' || msg === ':q' || msg === '/exit' || msg === '/quit') {
      return { action: 'exit', history };
    }

    // Part C: after a task, a short non-technical line probably means "done with
    // tools." Offer the switch back once rather than guessing — the stored line
    // is answered by whichever mode the user picks.
    if (taskJustCompleted && looksConversational(msg)) {
      display.warning('Sounds like we\'re back to just talking — press Enter (or y) to switch to Gazelle, or keep typing to stay in coder.');
      pendingReturnFor = msg;
      taskJustCompleted = false;
      continue;
    }

    await runTask(msg);
    taskJustCompleted = true;
  }
}
