/**
 * Command dispatch for the web client.
 *
 * The `/` menu used to paste a command into the composer, which then went to
 * the engine as an ordinary turn — so typing `:resume` made the model go and
 * research the word "resume". Anything beginning with `:` is a command, and a
 * command must either run or say why it cannot. It must never be sent to the
 * model as if it were a question.
 *
 * Three groups:
 *
 *   LOCAL     — has a real equivalent here (sessions, usage, settings), so it
 *               runs against the protocol or the UI.
 *   TERMINAL  — implemented in the TUI's REPL loop (src/cli/index.ts) against
 *               objects the protocol does not expose. Reported honestly as
 *               terminal-only rather than silently swallowed.
 *   UNKNOWN   — not a command at all.
 *
 * Moving a TERMINAL command to LOCAL means giving the engine a protocol method
 * for it; nothing here should pretend otherwise in the meantime.
 */

export type CommandKind = 'local' | 'terminal' | 'unknown';

/** Commands the TUI owns that this client cannot yet run, with why. */
export const TERMINAL_ONLY = new Set([
  ':dream', ':rem', ':mine', ':research', ':btw', ':lessons', ':forget',
  ':council', ':machina', ':workflow', ':workflows',
  ':archon', ':archoff', ':archmodel',
  ':compon', ':compoff', ':comp',
  ':turnson', ':turnsoff',
  ':speak', ':doctor', ':compact', ':compress',
]);

export function classify(input: string): CommandKind {
  const head = input.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!head.startsWith(':')) return 'unknown';
  if (TERMINAL_ONLY.has(head)) return 'terminal';
  return LOCAL_COMMANDS.has(head) ? 'local' : 'terminal';
}

export const LOCAL_COMMANDS = new Set([
  ':new', ':resume', ':sessions', ':history', ':id', ':save',
  ':context', ':usage', ':model', ':provider', ':apikey', ':approve',
  ':help', ':q',
]);

/** Everything a command needs to actually do something. */
export interface CommandContext {
  t: (key: string) => string;
  sessionId: string | null;
  conversations: Array<{ sessionId: string; title: string; at: number }>;
  messages: Array<{ role: string }>;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number } | null;
  newChat: () => void;
  openChat: (id: string) => void;
  note: (text: string) => void;
  openSettings: (tab: 'general' | 'provider' | 'skills' | 'about') => void;
  openCommandMenu: () => void;
}

/**
 * Run a command. Returns true when it was handled — the caller must not fall
 * through to sending it as a turn.
 */
export function runCommand(input: string, ctx: CommandContext): boolean {
  const trimmed = input.trim();
  const [head] = trimmed.split(/\s+/);
  const arg = trimmed.slice(head.length).trim();
  const cmd = head.toLowerCase();
  if (!cmd.startsWith(':')) return false;

  switch (cmd) {
    case ':new':
      ctx.newChat();
      return true;

    case ':resume': {
      const latest = ctx.conversations[0];
      if (!latest) { ctx.note(ctx.t('cmd.noSessions')); return true; }
      ctx.openChat(latest.sessionId);
      ctx.note(`${ctx.t('cmd.resumed')} ${latest.title}`);
      return true;
    }

    case ':sessions': {
      if (ctx.conversations.length === 0) { ctx.note(ctx.t('cmd.noSessions')); return true; }
      ctx.note([
        `${ctx.t('app.conversations')} (${ctx.conversations.length})`,
        '',
        ...ctx.conversations.map((c, i) =>
          `${String(i + 1).padStart(2)}. ${c.title}${c.sessionId === ctx.sessionId ? '  ←' : ''}`),
      ].join('\n'));
      return true;
    }

    case ':history': {
      const turns = ctx.messages.filter((m) => m.role === 'user').length;
      ctx.note(`${turns} ${ctx.t('cmd.turns')}`);
      return true;
    }

    case ':id':
      ctx.note(ctx.sessionId ?? ctx.t('cmd.noSession'));
      return true;

    case ':context':
    case ':usage': {
      if (!ctx.usage) { ctx.note(ctx.t('cmd.noUsage')); return true; }
      const { inputTokens, outputTokens, costUsd } = ctx.usage;
      ctx.note([
        `in  ${inputTokens.toLocaleString()}`,
        `out ${outputTokens.toLocaleString()}`,
        costUsd !== undefined ? `cost $${costUsd.toFixed(4)}` : null,
      ].filter(Boolean).join('\n'));
      return true;
    }

    case ':model':
    case ':provider':
    case ':apikey':
      ctx.openSettings('provider');
      return true;

    case ':approve':
      ctx.openSettings('general');
      return true;

    case ':help':
      ctx.openCommandMenu();
      return true;

    case ':save':
      // Renaming needs a protocol method the engine does not have; saying so
      // beats a control that appears to work and quietly does nothing.
      ctx.note(arg ? ctx.t('cmd.renameUnsupported') : ctx.t('cmd.renameUnsupported'));
      return true;

    case ':q':
      ctx.note(ctx.t('cmd.quit'));
      return true;

    default:
      ctx.note(`${cmd} — ${ctx.t('cmd.terminalOnly')}`);
      return true;
  }
}
