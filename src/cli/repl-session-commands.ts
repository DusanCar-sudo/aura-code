/**
 * REPL commands that operate on the conversation itself: which session is
 * active, what is in its history, and whether it is saved.
 *
 * Extracted from index.ts so these can be tested. index.ts self-executes —
 * it reads ~/.secrets/agents.env into process.env at import (see its first
 * lines) and loads project/global config at module scope — so importing it
 * from a test would pull real credentials into the test process. Nothing in
 * this module runs at import, and it reaches its caller's state only through
 * the context object, so a test can call it directly.
 *
 * The commands here share one property that makes them a coherent unit: each
 * either changes *which* conversation is current or empties the current one.
 * That is exactly the set that must reset the session budget — see
 * SessionBudget.reset for why a stale total otherwise makes the ceiling
 * per-process rather than per-conversation.
 */

import chalk from 'chalk';
import { sessionStore } from '../agent/session-store.js';
import { TEXT_DIM_HEX } from './diamond.js';
import type { HistoryMessage } from '../providers/types.js';
import type { SessionBudget } from '../agent/session-budget.js';
import { emit } from '../commands/surface.js';

export interface ChatState {
  projectRoot: string;
  activeChatId: string | undefined;
  activeChatHistory: HistoryMessage[];
  activeChatTitle: string | undefined;
  noSession: boolean;
}

/** Which loop a typed line runs through: the full tool-using agent, or lean
 *  conversation. See the :gazelle/:coder branches in index.ts. */
export type ReplMode = 'coder' | 'gazelle';

export interface ReplCommandResult {
  handled: boolean;
  newChatId?: string | undefined;
  newHistory?: HistoryMessage[];
  newTitle?: string | undefined;
  newArchimedesOverride?: boolean;
  newArchimedesModelOverride?: string;
  newSmall1Override?: boolean;
  newMode?: ReplMode;
  newTurnsOverride?: number | undefined;
  /** The reasoning effort rung a `:effort <level>` set, for the caller to
   *  carry onto the session so the next provider build sends it. Mirrors
   *  newTurnsOverride: reporting a change without carrying it would leave the
   *  surface announcing a rung no turn will honour. */
  newEffort?: string | undefined;
  /** The REPL's conversation was swapped for a different one (:resume, :new,
   *  :clear-history, deleting the active session) — as opposed to being edited
   *  in place (:compact). A coder task still streaming when this lands must not
   *  write its result back over the conversation the user just switched to. */
  sessionReplaced?: boolean;
  /** Computer use was toggled — the REPL redraws its status line so a feature
   *  that can move the real pointer is never on without being visible. */
  newComputerUse?: boolean;
  /** Something else the status line reports changed (the permission level).
   *  Nothing redraws that bar on its own, so a command that flips it and does
   *  not say so leaves the bar announcing a state that is no longer true. */
  statusChanged?: boolean;
  /** A task the command wants the agent to carry out — `:catchthis run` hands
   *  a recorded procedure back this way rather than reaching into the REPL. */
  runTask?: string;
}

/** The slice of ReplCtx these commands touch. Declared structurally rather
 *  than importing ReplCtx so this module never depends on index.ts. */
export interface SessionCommandCtx {
  chatState: ChatState;
  budget: SessionBudget;
}

/**
 * Returns a result when `input` is one of these commands, or null to let the
 * caller's remaining branches try it. The caller must invoke this at the same
 * point in its if-chain that these branches previously occupied — calling it
 * earlier would let these commands shadow ones declared above them.
 */
export async function handleSessionCommand(
  input: string,
  c: SessionCommandCtx,
): Promise<ReplCommandResult | null> {
  if (input === ':resume' || input === ':resume ') {
    // Prefer this project's latest; if it has none (a fresh directory), fall
    // back to the most recent session anywhere, so `:resume` is predictable —
    // it always brings back your last conversation.
    let latest: { id: string; title: string; history: HistoryMessage[] } | null =
      sessionStore.findLatestSession(c.chatState.projectRoot);
    let fromOtherProject: string | undefined;
    if (!latest) {
      const anywhere = sessionStore.listAllSessions()[0];
      if (anywhere) {
        latest = anywhere;
        fromOtherProject = anywhere.project.replace(/^_/, '');
      }
    }
    if (!latest) {
      emit(chalk.hex(TEXT_DIM_HEX)('\n  No saved sessions to resume anywhere.\n'));
      return { handled: true };
    }
    c.budget.reset();   // a different conversation, so a different total
    emit(chalk.hex('#5a9e6e')(`\n  ↩ Resuming ${latest.id} — "${latest.title}" (${Math.floor(latest.history.length / 2)} turns)\n`));
    if (fromOtherProject) {
      emit(chalk.hex(TEXT_DIM_HEX)(
        `  ⚠ from another project (${fromOtherProject.slice(0, 40)}) — history loaded, tools run against the current directory.\n`,
      ));
    }
    return { handled: true, sessionReplaced: true, newChatId: latest.id, newHistory: latest.history, newTitle: latest.title };
  }

  if (input.startsWith(':resume ')) {
    const rawArg = input.slice(':resume '.length).trim();
    let id = rawArg;
    const numMatch = rawArg.match(/^#?(\d+)$/);
    if (numMatch) {
      const index = parseInt(numMatch[1], 10) - 1;
      // Numbering matches the merged `:sessions` list (all projects).
      const list = sessionStore.listAllSessions();
      if (index >= 0 && index < list.length) {
        id = list[index].id;
      }
    }
    let loaded: { id: string; title: string; history: HistoryMessage[] } | null =
      await sessionStore.loadSession(c.chatState.projectRoot, id);
    let fromOtherProject: string | undefined;
    if (!loaded) {
      // Not in this project — look across every project directory, so a
      // session id from `:sessions all` resumes regardless of cwd.
      const anywhere = sessionStore.findSessionAnywhere(id);
      if (anywhere) {
        loaded = anywhere;
        fromOtherProject = anywhere.project.replace(/^_/, '');
      }
    }
    if (!loaded) {
      emit(chalk.hex('#b15439')(`\n  ✗ Session not found: ${rawArg}  (try :sessions all)\n`));
      return { handled: true };
    }
    c.budget.reset();   // a different conversation, so a different total
    emit(chalk.hex('#5a9e6e')(`\n  ↩ Resumed ${loaded.id} — "${loaded.title}" (${Math.floor(loaded.history.length / 2)} turns)\n`));
    if (fromOtherProject) {
      emit(chalk.hex(TEXT_DIM_HEX)(
        `  ⚠ This session was saved under a different project (${fromOtherProject.slice(0, 40)}). ` +
        `Its history is loaded, but tools run against the current directory.\n`,
      ));
    }
    return { handled: true, sessionReplaced: true, newChatId: loaded.id, newHistory: loaded.history, newTitle: loaded.title };
  }

  if (input === ':new') {
    const newId = sessionStore.generateId();
    // History is dropped, so the spend that history drove must be dropped with
    // it — otherwise the budget is a process ceiling wearing a session's name
    // and this command cannot clear an exhausted one.
    c.budget.reset();
    emit(chalk.hex('#5a9e6e')(`\n  ✓ New session started: ${newId}\n`));
    return { handled: true, sessionReplaced: true, newChatId: newId, newHistory: [], newTitle: undefined };
  }

  if (input === ':history') {
    const turns = Math.floor(c.chatState.activeChatHistory.length / 2);
    emit(chalk.hex(TEXT_DIM_HEX)(`\n  Current session: ${turns} turn${turns !== 1 ? 's' : ''} in history.\n`));
    return { handled: true };
  }

  if (input === ':clear-history') {
    // Same reasoning as :new — only the session id survives. The exhaustion
    // message offers this as the other way out, so it has to work too.
    c.budget.reset();
    emit(chalk.hex('#5a9e6e')('\n  ✓ Conversation history cleared.\n'));
    return { handled: true, sessionReplaced: true, newHistory: [] };
  }

  if (input === ':save' || input.startsWith(':save ')) {
    const title = input.startsWith(':save ') ? input.slice(':save '.length).trim() : undefined;
    const cs = c.chatState;
    if (!cs.activeChatId) {
      emit(chalk.hex(TEXT_DIM_HEX)('\n  No active session to save (--no-session mode).\n'));
      return { handled: true };
    }
    const session = await sessionStore.upsertSession(cs.projectRoot, cs.activeChatId, cs.activeChatHistory, title ?? cs.activeChatTitle);
    emit(chalk.hex('#5a9e6e')(`\n  ✓ Saved as "${session.title}" (${cs.activeChatId})\n`));
    return { handled: true, newTitle: session.title };
  }

  if (input.startsWith(':delete ')) {
    const rawArg = input.slice(':delete '.length).trim();
    let id = rawArg;
    const numMatch = rawArg.match(/^#?(\d+)$/);
    if (numMatch) {
      const index = parseInt(numMatch[1], 10) - 1;
      // Numbering matches the merged `:sessions` list (all projects).
      const list = sessionStore.listAllSessions();
      if (index >= 0 && index < list.length) {
        id = list[index].id;
      }
    }
    let deleted = await sessionStore.deleteSession(c.chatState.projectRoot, id);
    if (!deleted) {
      // Merged list may point at a session in another project.
      const elsewhere = sessionStore.findSessionAnywhere(id);
      if (elsewhere) deleted = await sessionStore.deleteSession(elsewhere.projectRoot, id);
    }
    if (deleted) {
      emit(chalk.hex('#5a9e6e')(`\n  ✓ Deleted session ${id}\n`));
      if (id === c.chatState.activeChatId) {
        const newId = sessionStore.generateId();
        c.budget.reset();   // deleting the active session starts a fresh one
        emit(chalk.hex(TEXT_DIM_HEX)(`  Starting new session: ${newId}\n`));
        return { handled: true, sessionReplaced: true, newChatId: newId, newHistory: [], newTitle: undefined };
      }
    } else {
      emit(chalk.hex('#b15439')(`\n  ✗ Session not found: ${rawArg}\n`));
    }
    return { handled: true };
  }

  return null;
}
