/**
 * Command dispatch for the web client.
 *
 * The `/` menu used to paste a command into the composer, which then went to
 * the engine as an ordinary turn — so typing `:resume` made the model go and
 * research the word "resume". Anything beginning with `:` is a command, and a
 * command must either run or say why it cannot. It must never be sent to the
 * model as if it were a question.
 *
 * That much has been true here for a while. What was missing was somewhere for
 * the commands to actually run: this file could serve fourteen of them from
 * the browser's own state and answered the other fifty-two with "terminal
 * only", even though most of them have nothing to do with a terminal. The
 * engine now exposes `command.run` over the protocol, backed by the same
 * implementations the REPL uses (src/commands/core.ts), so the split is:
 *
 *   LOCAL   — the answer lives in this client's own UI. `:model` should open
 *             the model picker, not print a list; `:new` should swap the
 *             thread on screen. Running these on the engine would be a worse
 *             answer, not an equivalent one.
 *   ENGINE  — everything else. Sent to `command.run`, output shown in the
 *             thread. If the engine reports it as terminal-only, the client
 *             says which command and why.
 *
 * There is no third group any more. A command this file does not recognise is
 * still a command, and goes to the engine rather than to the model.
 */

export type CommandKind = 'local' | 'engine';

/**
 * Commands answered by this client's own UI. Everything else goes to the
 * engine — see `classify`.
 *
 * `:context` and `:usage` are deliberately here rather than on the engine:
 * the browser holds the live per-turn usage the engine does not track for a
 * remote session, so the local answer is the accurate one.
 */
export const LOCAL_COMMANDS = new Set([
  ':new', ':resume', ':sessions', ':history', ':id',
  ':context', ':usage', ':model', ':provider', ':apikey',
  ':help', ':q', ':quit',
]);

export function classify(input: string): CommandKind {
  const head = input.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return LOCAL_COMMANDS.has(head) ? 'local' : 'engine';
}

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
  /** Opens a Settings tab. The names are Settings.tsx's own `SettingsTab`
   *  union — spelling them independently here is how `:model` ended up
   *  opening a tab that no longer existed, and a blank panel. */
  openSettings: (tab: 'agents' | 'models' | 'skills' | 'autonomy' | 'general') => void;
  openCommandMenu: () => void;
  /** Runs the command on the engine. Resolves true once it has been answered
   *  — including when the answer is "that one needs the terminal". */
  runOnEngine: (command: string) => Promise<boolean>;
}

/**
 * Run a command. Returns true when it was handled — the caller must not fall
 * through to sending it as a turn.
 *
 * Engine commands are dispatched without awaiting: the answer arrives in the
 * thread as a note, the same way a turn's output does, so the composer is not
 * held while `:doctor` or `:graph` does its work.
 */
export function runCommand(input: string, ctx: CommandContext): boolean {
  const trimmed = input.trim();
  const [head] = trimmed.split(/\s+/);
  const cmd = head.toLowerCase();
  if (!cmd.startsWith(':') && !cmd.startsWith('/')) return false;

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
      ctx.openSettings('models');
      return true;

    case ':help':
      ctx.openCommandMenu();
      return true;

    case ':q':
    case ':quit':
      ctx.note(ctx.t('cmd.quit'));
      return true;

    default:
      // Not one this client answers better itself — the engine runs it.
      void ctx.runOnEngine(trimmed);
      return true;
  }
}
