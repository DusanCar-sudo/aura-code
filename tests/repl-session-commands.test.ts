import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  handleSessionCommand,
  type SessionCommandCtx,
  type ChatState,
} from '../src/cli/repl-session-commands.js';
import { SessionBudget } from '../src/agent/session-budget.js';
import { sessionStore } from '../src/agent/session-store.js';
import type { HistoryMessage } from '../src/providers/types.js';

/**
 * The gap this closes: these assertions were impossible while the commands
 * lived in cli/index.ts, which self-executes on import. The previous suite
 * could only prove SessionBudget.reset() works in isolation — not that any
 * command actually calls it, so a regression deleting the call would have
 * shipped green.
 */

const PROJECT = '/fake/project';

const historyOf = (n: number): HistoryMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `m${i}`,
  }));

describe('REPL session commands reset the budget', () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-session-cmd-'));
    vi.stubEnv('AURA_SESSION_DIR', tmpDir);
    vi.stubEnv('AURA_SESSION_BUDGET', '');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A context whose budget has already been spent past its ceiling — the
   *  state a user is actually in when they reach for :new. */
  const spentCtx = (over: Partial<ChatState> = {}): SessionCommandCtx => {
    const budget = new SessionBudget({ maxInputTokens: 1_000 });
    budget.recordCall(1_200);
    budget.recordTurn();
    return {
      budget,
      chatState: {
        projectRoot: PROJECT,
        activeChatId: 'active-id',
        activeChatHistory: historyOf(4),
        activeChatTitle: 'Old work',
        noSession: false,
        ...over,
      },
    };
  };

  it(':new calls reset — the assertion the old structure could not make', async () => {
    const c = spentCtx();
    expect(c.budget.exhausted()).not.toBeNull();     // blocked before

    const r = await handleSessionCommand(':new', c);

    expect(r).not.toBeNull();
    expect(r!.handled).toBe(true);
    expect(r!.newHistory).toEqual([]);
    expect(r!.newChatId).toBeTruthy();
    expect(r!.newChatId).not.toBe('active-id');      // a genuinely new session
    expect(c.budget.inputTokensUsed).toBe(0);        // …and the total went with it
    expect(c.budget.turnsUsed).toBe(0);
    expect(c.budget.exhausted()).toBeNull();
  });

  it(':clear-history calls reset while keeping the session id', async () => {
    const c = spentCtx();
    const r = await handleSessionCommand(':clear-history', c);

    expect(r!.handled).toBe(true);
    expect(r!.newHistory).toEqual([]);
    expect(r!.newChatId).toBeUndefined();            // same session id, by design
    expect(c.budget.exhausted()).toBeNull();
    expect(c.budget.inputTokensUsed).toBe(0);
  });

  it(':resume calls reset when switching to the latest session', async () => {
    await sessionStore.upsertSession(PROJECT, 'saved-1', historyOf(6), 'Earlier work');
    const c = spentCtx();

    const r = await handleSessionCommand(':resume', c);

    expect(r!.newChatId).toBe('saved-1');
    expect(r!.newTitle).toBe('Earlier work');
    expect(c.budget.exhausted()).toBeNull();
    expect(c.budget.inputTokensUsed).toBe(0);
  });

  it(':resume <id> calls reset when switching to a named session', async () => {
    await sessionStore.upsertSession(PROJECT, 'saved-2', historyOf(2), 'Named');
    const c = spentCtx();

    const r = await handleSessionCommand(':resume saved-2', c);

    expect(r!.newChatId).toBe('saved-2');
    expect(c.budget.exhausted()).toBeNull();
  });

  it(':delete of the ACTIVE session calls reset and starts a new one', async () => {
    await sessionStore.upsertSession(PROJECT, 'active-id', historyOf(2), 'Doomed');
    const c = spentCtx();

    const r = await handleSessionCommand(':delete active-id', c);

    expect(r!.newChatId).toBeTruthy();
    expect(r!.newChatId).not.toBe('active-id');
    expect(r!.newHistory).toEqual([]);
    expect(c.budget.exhausted()).toBeNull();
  });

  // ── the negative cases: reset must not fire indiscriminately ──────────────

  it(':delete of a DIFFERENT session leaves the budget alone', async () => {
    // The current conversation continues unchanged, so its spend still counts.
    await sessionStore.upsertSession(PROJECT, 'other-id', historyOf(2), 'Other');
    const c = spentCtx();

    const r = await handleSessionCommand(':delete other-id', c);

    expect(r!.handled).toBe(true);
    expect(r!.newChatId).toBeUndefined();
    expect(c.budget.inputTokensUsed).toBe(1_200);    // untouched
    expect(c.budget.exhausted()).not.toBeNull();
  });

  it(':history and :save are read-only and never reset', async () => {
    for (const cmd of [':history', ':save', ':save A title']) {
      const c = spentCtx();
      const r = await handleSessionCommand(cmd, c);
      expect(r!.handled).toBe(true);
      expect(c.budget.inputTokensUsed).toBe(1_200);
      expect(c.budget.exhausted()).not.toBeNull();
    }
  });

  it('a failed :resume leaves the budget alone', async () => {
    // Nothing was switched to, so nothing should be cleared.
    const c = spentCtx();
    const r = await handleSessionCommand(':resume no-such-id', c);

    expect(r!.handled).toBe(true);
    expect(r!.newChatId).toBeUndefined();
    expect(c.budget.inputTokensUsed).toBe(1_200);
  });

  it('returns null for anything it does not own, so the caller chain continues', async () => {
    // Guards the delegation contract: index.ts falls through to its remaining
    // ~45 branches only because unmatched input yields null.
    const c = spentCtx();
    for (const cmd of [':model gpt-5', ':help', ':speak', 'just a task', ':newish']) {
      expect(await handleSessionCommand(cmd, c)).toBeNull();
    }
    expect(c.budget.inputTokensUsed).toBe(1_200);
  });
});
