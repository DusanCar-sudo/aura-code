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
    const latest = sessionStore.findLatestSession(c.chatState.projectRoot);
    if (!latest) {
      console.log(chalk.hex(TEXT_DIM_HEX)('\n  No saved sessions to resume.\n'));
      return { handled: true };
    }
    c.budget.reset();   // a different conversation, so a different total
    console.log(chalk.hex('#5a9e6e')(`\n  ↩ Resuming ${latest.id} — "${latest.title}" (${Math.floor(latest.history.length / 2)} turns)\n`));
    return { handled: true, newChatId: latest.id, newHistory: latest.history, newTitle: latest.title };
  }

  if (input.startsWith(':resume ')) {
    const id = input.slice(':resume '.length).trim();
    const loaded = await sessionStore.loadSession(c.chatState.projectRoot, id);
    if (!loaded) {
      console.log(chalk.hex('#b15439')(`\n  ✗ Session not found: ${id}\n`));
      return { handled: true };
    }
    c.budget.reset();   // a different conversation, so a different total
    console.log(chalk.hex('#5a9e6e')(`\n  ↩ Resumed ${loaded.id} — "${loaded.title}" (${Math.floor(loaded.history.length / 2)} turns)\n`));
    return { handled: true, newChatId: loaded.id, newHistory: loaded.history, newTitle: loaded.title };
  }

  if (input === ':new') {
    const newId = sessionStore.generateId();
    // History is dropped, so the spend that history drove must be dropped with
    // it — otherwise the budget is a process ceiling wearing a session's name
    // and this command cannot clear an exhausted one.
    c.budget.reset();
    console.log(chalk.hex('#5a9e6e')(`\n  ✓ New session started: ${newId}\n`));
    return { handled: true, newChatId: newId, newHistory: [], newTitle: undefined };
  }

  if (input === ':history') {
    const turns = Math.floor(c.chatState.activeChatHistory.length / 2);
    console.log(chalk.hex(TEXT_DIM_HEX)(`\n  Current session: ${turns} turn${turns !== 1 ? 's' : ''} in history.\n`));
    return { handled: true };
  }

  if (input === ':clear-history') {
    // Same reasoning as :new — only the session id survives. The exhaustion
    // message offers this as the other way out, so it has to work too.
    c.budget.reset();
    console.log(chalk.hex('#5a9e6e')('\n  ✓ Conversation history cleared.\n'));
    return { handled: true, newHistory: [] };
  }

  if (input === ':save' || input.startsWith(':save ')) {
    const title = input.startsWith(':save ') ? input.slice(':save '.length).trim() : undefined;
    const cs = c.chatState;
    if (!cs.activeChatId) {
      console.log(chalk.hex(TEXT_DIM_HEX)('\n  No active session to save (--no-session mode).\n'));
      return { handled: true };
    }
    const session = await sessionStore.upsertSession(cs.projectRoot, cs.activeChatId, cs.activeChatHistory, title ?? cs.activeChatTitle);
    console.log(chalk.hex('#5a9e6e')(`\n  ✓ Saved as "${session.title}" (${cs.activeChatId})\n`));
    return { handled: true, newTitle: session.title };
  }

  if (input.startsWith(':delete ')) {
    const id = input.slice(':delete '.length).trim();
    const deleted = await sessionStore.deleteSession(c.chatState.projectRoot, id);
    if (deleted) {
      console.log(chalk.hex('#5a9e6e')(`\n  ✓ Deleted session ${id}\n`));
      if (id === c.chatState.activeChatId) {
        const newId = sessionStore.generateId();
        c.budget.reset();   // deleting the active session starts a fresh one
        console.log(chalk.hex(TEXT_DIM_HEX)(`  Starting new session: ${newId}\n`));
        return { handled: true, newChatId: newId, newHistory: [], newTitle: undefined };
      }
    } else {
      console.log(chalk.hex('#b15439')(`\n  ✗ Session not found: ${id}\n`));
    }
    return { handled: true };
  }

  return null;
}
