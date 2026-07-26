/**
 * Action wire-format parsing for the Telegram bot.
 *
 * Two dialects, one executor. The system prompt asks the model for a bare
 * `RUN: <cmd>` line, but deepseek-v4-flash (and any Hermes/Qwen-lineage model)
 * emits XML tool calls instead. For a week that XML matched nothing, executed
 * nothing, and was rendered to the user as chat text — while the model, never
 * seeing a tool result, invented one ("snapshot taken and sent"). Constraining
 * the model by prompt alone had already failed, so the parser accepts both
 * dialects and routes them into the same executor in telegram-bot.ts.
 *
 * Every XML variant handled here was observed in the real session store
 * (~/.aura/sessions/telegram/8519031951.json), not imagined:
 *
 *   <tool_call><function=run><parameter=command>ls</parameter></function></tool_call>
 *   <function=run><parameter>ls</parameter></function>      ← unnamed parameter
 *   <function=cam><parameter=default></function>            ← no closing </parameter>
 *
 * plus a prose preamble before the call, which is discarded exactly as the bare
 * format's preamble already was.
 *
 * Lives in its own module so it can be unit-tested: importing telegram-bot.ts
 * calls poll() at module scope and would start a second live bot instance.
 */

export type ActionVerb = 'RUN' | 'SEND' | 'CAM';
export interface ParsedAction {
  verb: ActionVerb;
  arg: string;
}

/** Any fragment that looks like tool-call markup, for leak detection. */
const RESIDUE_SOURCE = /<\/?(?:tool_call|function|parameter)\b[^>]*>/gi;

/** True when the text carries tool-call markup. Stateless — builds a fresh
 *  regex per call, since a shared /g regex carries lastIndex between .test()
 *  calls and would alternate true/false on identical input. */
export function hasToolCallResidue(text: string): boolean {
  return new RegExp(RESIDUE_SOURCE.source, 'i').test(text);
}

/** Map a model's function name onto the executor's verb. */
function verbFromFunctionName(name: string): ActionVerb | null {
  switch (name.toLowerCase()) {
    case 'run': case 'shell': case 'bash': return 'RUN';
    case 'send': case 'send_file': case 'sendfile': return 'SEND';
    case 'cam': case 'webcam': case 'camera': return 'CAM';
    default: return null;
  }
}

/**
 * Extract an action from either wire format, or null for a plain answer.
 *
 * XML is tried first: an XML command may legitimately contain the substring
 * `RUN:` (e.g. `grep RUN: file`), and matching the bare form there would
 * truncate the command at that point.
 */
export function parseAgentAction(text: string): ParsedAction | null {
  // Tolerate a missing </function> (truncated generation) by falling back to
  // end-of-string, so a cut-off call still executes rather than leaking.
  const xml = text.match(/<function\s*=\s*([\w-]+)\s*>([\s\S]*?)(?:<\/function>|$)/i);
  if (xml) {
    const verb = verbFromFunctionName(xml[1]);
    if (verb) {
      const inner = xml[2] ?? '';
      // The parameter may be named (<parameter=command>), unnamed
      // (<parameter>), or unclosed. Absent entirely → the whole inner body is
      // the argument.
      const param = inner.match(/<parameter(?:\s*=\s*[\w-]+)?\s*>([\s\S]*?)(?:<\/parameter>|$)/i);
      const raw = param ? param[1] : inner;
      // Strip stray tags the tolerant matches may have swept in, so a malformed
      // call can never smuggle markup into the shell.
      return {
        verb,
        arg: raw.replace(new RegExp(RESIDUE_SOURCE.source, 'gi'), '').trim(),
      };
    }
    // A known-looking call with an unknown function name is NOT an action, and
    // must not fall through to the bare matcher — the caller logs it as a leak.
  }

  // Bare format. Models often wrap the directive in markdown — a leading
  // backtick, bullet, or blockquote — so tolerate those and strip a trailing
  // backtick from the argument.
  const bare = text.match(/(?:^|\n)[ \t`>*_-]*(RUN|SEND|CAM):[ \t]*`?([^\n`]+)/);
  if (bare) {
    return {
      verb: bare[1] as ActionVerb,
      arg: (bare[2] || '').trim().replace(/`+$/, '').trim(),
    };
  }
  return null;
}

/** Remove directive fragments of both dialects from user-facing text. */
export function stripDirectives(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<function\s*=[\s\S]*?(?:<\/function>|$)/gi, '')
    .replace(new RegExp(RESIDUE_SOURCE.source, 'gi'), '')
    .replace(/[ \t`>*_-]*(RUN|SEND|CAM):[^\n]*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Words asserting a file/photo actually reached the user. Only consulted when
 *  no SEND/CAM ran this turn, so a genuine delivery never trips them. */
const MEDIA_NOUN_RE = /(webcam|snapshot|photo|picture|camera|slik|fotografij|snimak|snimk)/i;
const DELIVERED_RE = /(sent|delivered|attached|done|poslala|poslao|snimila|snimio|evo ti|gotovo)/i;

/** True when the text claims a delivery — checked against whether one ran. */
export function claimsDelivery(text: string): boolean {
  return MEDIA_NOUN_RE.test(text) && DELIVERED_RE.test(text);
}

/** Longest command shown in the provenance footer before truncation. */
const PROVENANCE_MAX_CHARS = 120;

/**
 * Render the list of actions that actually executed, appended to any reply
 * that ran one.
 *
 * Why this exists: the first live test of the XML parser executed a single
 * `ps aux --sort=-%cpu | head -40` and the model reported "no cron jobs or
 * system timers" — a machine with 14 cron jobs and 7 timers. Nothing about
 * cron was ever queried. Verifying arbitrary factual claims against command
 * output is not tractable here, but stating what was actually run is, and it
 * turns an invisible fabrication into an obvious mismatch the reader catches
 * in one glance.
 */
export function formatProvenance(calls: readonly string[]): string {
  if (calls.length === 0) return '';
  const lines = calls.map((c) => {
    const flat = c.replace(/\s+/g, ' ').trim();
    const shown = flat.length > PROVENANCE_MAX_CHARS
      ? flat.slice(0, PROVENANCE_MAX_CHARS - 1) + '…'
      : flat;
    return `• \`${shown}\``;
  });
  return `🔍 Stvarno izvršeno (${calls.length}):\n${lines.join('\n')}`;
}
