/**
 * Action wire-format parsing for the Telegram bot.
 *
 * ## Primary path: native tool calling
 *
 * The bot now sends `TOOL_DEFINITIONS` to the provider and reads `toolCalls`
 * off the response (`toolCallToAction`). The DeepSeek endpoint the bot runs
 * against (https://api.deepseek.com/v1, deepseek-v4-flash) supports this
 * natively — a probe on 2026-08-19 returned `finish_reason: "tool_calls"` with
 * a well-formed call — so the model no longer has to be coaxed into a
 * hand-rolled dialect by prompt text.
 *
 * ## Fallback path: the XML dialects (parseAgentAction)
 *
 * Kept for models that ignore the tools array. Two dialects were observed in
 * the real session store (~/.aura/sessions/telegram/8519031951.json), not
 * imagined, and both are handled:
 *
 *   A) <tool_call><function=run><parameter=command>ls</parameter></function></tool_call>
 *      <function=run><parameter>ls</parameter></function>   ← unnamed parameter
 *      <function=cam><parameter=default></function>         ← valueless parameter
 *
 *   B) <tool_run><command>ps aux | grep -i claude</command></｜｜DSML｜｜_tool>
 *      ← the dialect the model actually emits today. Note the closer is a
 *        DeepSeek fullwidth special token, not </tool_run>. Dialect B matched
 *        NEITHER branch of the previous parser, so every one of those turns
 *        executed nothing and was rendered to the user as raw chat text.
 *
 * plus a prose preamble before the call, which is discarded.
 *
 * ## Truncation is never executed
 *
 * A generation cut off by the token limit used to match to end-of-string and
 * run: `<function=run><parameter=command>rm -rf ~/projects/old` truncated to
 * `rm -rf ~/pro` is a different, destructive command. Both container patterns
 * now REQUIRE their closing tag; an opening tag without one yields
 * `{kind:'truncated'}`, which the caller must not execute.
 *
 * Lives in its own module so it can be unit-tested: importing telegram-bot.ts
 * calls poll() at module scope and would start a second live bot instance.
 */

import type { ToolDefinition } from '../providers/types.js';

export type ActionVerb = 'RUN' | 'SEND' | 'CAM' | 'SEARCH';

export interface ParsedAction {
  verb: ActionVerb;
  arg: string;
}

/**
 * Outcome of reading a model turn.
 *
 * `ParsedAction | null` was not enough: it conflated "the model wrote a plain
 * answer" with "the model started a tool call that got cut off mid-command",
 * and the second case must never reach the shell.
 */
export type ParseResult =
  | { kind: 'action'; verb: ActionVerb; arg: string }
  | { kind: 'truncated'; reason: string }
  | { kind: 'none' };

// ─────────────────────────────────────────────────────────────────────────────
// Native tool definitions — the primary protocol
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One tool per ActionVerb, each with a single required string parameter.
 * These replace the action documentation that used to live in the system
 * prompt: the schema IS the protocol description now.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'run',
    description:
      'Run a shell command on Dušan\'s Linux PC and return its output. Use for ' +
      'inspecting the machine (ps, free -h, df -h, ls, cat, grep, git status…). ' +
      'Prefer read-only commands; anything mutating asks Dušan to approve first.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'send',
    description:
      'Send a file from the PC to Dušan on Telegram. Images are sent as photos, ' +
      'everything else as a document. Use whenever he asks you to send, share, or ' +
      'give him a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or home-relative path to the file.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'cam',
    description:
      'Capture a webcam snapshot and send it to Dušan. Use for surveillance, ' +
      '"show me the room", or "take a photo" requests.',
    parameters: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Video device, e.g. /dev/video0. Leave empty for the default camera.',
        },
      },
    },
  },
  {
    name: 'search',
    description:
      'Search the web for real-time information: current events, prices, news, or ' +
      'anything outside your training data. Use this rather than guessing.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
  },
];

/** Map a model's function name onto the executor's verb. */
function verbFromFunctionName(name: string): ActionVerb | null {
  switch (name.toLowerCase()) {
    case 'run': case 'shell': case 'bash': return 'RUN';
    case 'send': case 'send_file': case 'sendfile': return 'SEND';
    case 'cam': case 'webcam': case 'camera': return 'CAM';
    case 'search': case 'websearch': case 'web_search': return 'SEARCH';
    default: return null;
  }
}

/** Argument key preferred per verb, then any string value as a fallback. */
const ARG_KEYS = ['command', 'path', 'query', 'device', 'cmd', 'file', 'input'];

/**
 * Convert one native tool call into an action. Returns null for a function
 * name outside the known set, so an unexpected tool can never be guessed into
 * a shell execution.
 */
export function toolCallToAction(
  call: { name: string; input?: Record<string, unknown> },
): ParsedAction | null {
  const verb = verbFromFunctionName(call.name);
  if (!verb) return null;

  const input = call.input ?? {};
  for (const key of ARG_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return { verb, arg: v.trim() };
  }
  // Some models emit a single unnamed/renamed property — take the first
  // string value rather than dropping the call on the floor.
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim()) return { verb, arg: v.trim() };
  }
  // No argument at all is legitimate for CAM (default device).
  return { verb, arg: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback: XML dialect parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Any fragment that looks like tool-call markup, for leak detection.
 *
 * The second alternation catches DeepSeek's fullwidth special tokens —
 * `<｜｜DSML｜｜_tool>` (U+FF5C) and ASCII-pipe variants like `<|im_end|>`.
 * Without it `hasToolCallResidue` returned false for the closer the model
 * actually emits, so nothing was logged and stripDirectives left the token
 * sitting in the user-facing reply.
 */
const RESIDUE_SOURCE =
  /<\/?(?:tool_call|tool_run|function|parameter|command)\b[^>]*>|<\/?[｜|][^>]*>/gi;

/** True when the text carries tool-call markup. Stateless — builds a fresh
 *  regex per call, since a shared /g regex carries lastIndex between .test()
 *  calls and would alternate true/false on identical input. */
export function hasToolCallResidue(text: string): boolean {
  return new RegExp(RESIDUE_SOURCE.source, 'i').test(text);
}

function scrub(s: string): string {
  return s.replace(new RegExp(RESIDUE_SOURCE.source, 'gi'), '').trim();
}

// Dialect A: <function=NAME> … </function>. The closing tag is REQUIRED.
const FN_OPEN_RE = /<function\s*=\s*([\w-]+)\s*>/i;
const FN_FULL_RE = /<function\s*=\s*([\w-]+)\s*>([\s\S]*?)<\/function>/i;
// A parameter value only counts when its closing tag is present too; an
// unclosed <parameter=default> inside a properly closed <function> is a
// valueless parameter, not a truncation.
const PARAM_FULL_RE = /<parameter(?:\s*=\s*[\w-]+)?\s*>([\s\S]*?)<\/parameter>/i;

// Dialect B: <tool_run> … <command> … </command>. Closed by </tool_run> or by
// a DeepSeek special token; what matters is that <command> itself is closed.
const TOOL_RUN_OPEN_RE = /<tool_run\b[^>]*>/i;
const COMMAND_FULL_RE = /<command\s*>([\s\S]*?)<\/command>/i;

/**
 * Extract an action from either XML dialect or the bare `RUN:` line.
 *
 * XML is tried first: an XML command may legitimately contain the substring
 * `RUN:` (e.g. `grep RUN: file`), and matching the bare form there would
 * truncate the command at that point.
 */
export function parseAgentAction(text: string): ParseResult {
  // ── Dialect A ─────────────────────────────────────────────────────────────
  const fnOpen = text.match(FN_OPEN_RE);
  if (fnOpen) {
    const full = text.match(FN_FULL_RE);
    if (!full) {
      return {
        kind: 'truncated',
        reason: `unterminated <function=${fnOpen[1]}> (no closing </function>)`,
      };
    }
    const verb = verbFromFunctionName(full[1]);
    if (!verb) {
      // A known-looking call with an unknown function name is NOT an action,
      // and must not fall through to the bare matcher — the caller logs it.
      return { kind: 'none' };
    }
    const inner = full[2] ?? '';
    const param = inner.match(PARAM_FULL_RE);
    const raw = param ? param[1] : inner;
    return { kind: 'action', verb, arg: scrub(raw) };
  }

  // ── Dialect B ─────────────────────────────────────────────────────────────
  if (TOOL_RUN_OPEN_RE.test(text)) {
    const cmd = text.match(COMMAND_FULL_RE);
    if (!cmd) {
      return {
        kind: 'truncated',
        reason: 'unterminated <tool_run> (no closed <command> block)',
      };
    }
    return { kind: 'action', verb: 'RUN', arg: scrub(cmd[1]) };
  }

  // A bare <command>…</command> with no wrapper, same intent.
  if (/<command\b/i.test(text)) {
    const cmd = text.match(COMMAND_FULL_RE);
    if (!cmd) {
      return { kind: 'truncated', reason: 'unterminated <command> block' };
    }
    return { kind: 'action', verb: 'RUN', arg: scrub(cmd[1]) };
  }

  // ── Bare format ───────────────────────────────────────────────────────────
  // Models often wrap the directive in markdown — a leading backtick, bullet,
  // or blockquote — so tolerate those and strip a trailing backtick.
  const bare = text.match(/(?:^|\n)[ \t`>*_-]*(RUN|SEND|CAM|SEARCH):[ \t]*`?([^\n`]+)/);
  if (bare) {
    return {
      kind: 'action',
      verb: bare[1] as ActionVerb,
      arg: (bare[2] || '').trim().replace(/`+$/, '').trim(),
    };
  }
  return { kind: 'none' };
}

/**
 * Remove directive fragments of every dialect from user-facing text.
 *
 * Unlike the parser, this intentionally tolerates unterminated tags: the point
 * is that no markup ever reaches the user, even from a cut-off generation.
 */
export function stripDirectives(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_run>[\s\S]*?(?:<\/tool_run>|<\/[｜|][^>]*>|$)/gi, '')
    .replace(/<function\s*=[\s\S]*?(?:<\/function>|$)/gi, '')
    .replace(/<command\s*>[\s\S]*?(?:<\/command>|$)/gi, '')
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

// ─────────────────────────────────────────────────────────────────────────────
// Shell-command classification
// ─────────────────────────────────────────────────────────────────────────────
// Lives here rather than in telegram-bot.ts purely so it can be unit-tested:
// importing telegram-bot.ts calls poll() at module scope. The approval gate is
// the last thing standing between a hallucinated command and Dušan's disk, so
// it needs tests more than anything else in this file.

/** Block only truly catastrophic commands; everything else is allowed. Shared
 *  by /run and the agentic chat loop so both enforce the same floor. */
export function isCatastrophic(cmd: string): boolean {
  const banned = [
    'rm -rf /', 'rm -rf /*', 'rm -rf ~', 'mkfs', 'dd if=/dev/zero', 'dd if=/dev/random',
    ':(){ :|:& };:', 'fork bomb', 'shutdown', 'poweroff', 'init 0', 'halt', 'reboot',
    '> /dev/sda', 'chmod -R 000 /', 'chown -R',
  ];
  const c = cmd.toLowerCase();
  return banned.some(d => c.includes(d.toLowerCase()));
}

/**
 * A command is "read-only" (safe to run without approval) only if EVERY
 * whitespace/pipe/;-separated segment starts with a known inspection command
 * AND it contains no output redirection. Anything else (writes, installs,
 * deletes, unknown binaries) requires explicit approval. Deny-by-default: if
 * we're not sure it's read-only, we treat it as needing approval.
 */
export const READ_ONLY_CMDS = new Set([
  'ls', 'cat', 'pwd', 'whoami', 'date', 'df', 'du', 'ps', 'top', 'free', 'uname',
  'which', 'find', 'grep', 'rg', 'head', 'tail', 'wc', 'echo', 'stat', 'file',
  'git', 'uptime', 'hostname', 'id', 'env', 'printenv', 'lsblk', 'lscpu', 'sensors',
  'nvidia-smi', 'systemctl', 'journalctl', 'sort', 'uniq', 'cut', 'awk', 'sed',
]);

/** git subcommands that write to the repo, the index, or config. */
const MUTATING_GIT = new Set([
  'push', 'commit', 'reset', 'checkout', 'switch', 'clean', 'rm', 'mv', 'add',
  'merge', 'rebase', 'apply', 'am', 'cherry-pick', 'revert', 'tag', 'config',
  'submodule', 'worktree', 'remote', 'init', 'clone', 'gc', 'prune',
  'filter-branch', 'stash', 'restore', 'fetch', 'pull',
]);

/** systemctl subcommands that change unit or manager state. */
const MUTATING_SYSTEMCTL = new Set([
  'start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask',
  'set-property', 'kill', 'isolate', 'daemon-reload', 'daemon-reexec',
  'set-default', 'edit', 'revert',
]);

export function isReadOnlyCommand(cmd: string): boolean {
  // ── Constructs that smuggle a second command past segment analysis ────────
  // Splitting on | ; && || and checking each segment's first token is only
  // sound if those are the ONLY ways to introduce a command. They are not:
  //   echo $(rm -rf ~/x)     → first token "echo", passes, rm still runs
  //   echo `rm -rf ~/x`      → same via backticks
  //   ls & rm -rf ~/x        → single & is a separator the split missed
  //   ls\nrm -rf ~/x         → newline is a separator too
  // Any of these means we cannot reason about the command, so it goes to
  // approval (not a block — Dušan approves it interactively if he meant it).
  if (/\$\(|`|\$\{/.test(cmd)) return false;           // command / brace substitution
  if (/(^|[^&])&([^&]|$)/.test(cmd)) return false;     // single & (background), not &&
  if (/[\n\r]/.test(cmd)) return false;                // newline separator
  if (/[>]|>>|\btee\b|\bdd\b/.test(cmd)) return false; // any redirection → mutating

  // ── Whitelisted binaries with mutating modes ─────────────────────────────
  // find -exec runs an arbitrary command; sed -i rewrites files in place; awk
  // and sed can redirect from inside their program string, which the quote-
  // blind scan above cannot see.
  if (/\s-execdir\b|\s-exec\b|\s-delete\b|\s-fprint\b/.test(cmd)) return false;
  if (/\bsed\b[^|;]*\s-[a-zA-Z]*i\b/.test(cmd)) return false;
  if (/\b(sed|awk)\b[^|;]*(printf?\s*>|>\s*")/.test(cmd)) return false;
  // Split on shell separators; every segment's first token must be read-only.
  const segments = cmd.split(/\||;|&&|\|\|/).map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    const tokens = seg.split(/\s+/).filter(Boolean);
    const first = tokens[0];
    if (first === 'sudo') return false;                       // sudo always needs approval
    if (!READ_ONLY_CMDS.has(first)) return false;

    // git and systemctl are whitelisted for their read-only subcommands, so the
    // subcommand itself decides. Scan every token rather than the one after the
    // binary: global options sit in between (`systemctl --user restart x`,
    // `git -C /tmp/repo commit`), and a flag's value is its own token, so no
    // fixed-position rule holds. Requiring adjacency is exactly why
    // `systemctl --user restart` used to execute without approval.
    if (first === 'git') {
      if (tokens.slice(1).some(t => MUTATING_GIT.has(t))) return false;
      // `git branch` only mutates with -d/-D/-m/-M.
      if (tokens.includes('branch') && tokens.some(t => /^-[dDmM]$/.test(t))) return false;
    }
    if (first === 'systemctl' && tokens.slice(1).some(t => MUTATING_SYSTEMCTL.has(t))) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command-output formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ffmpeg writes ~20 lines of build banner to stderr on every invocation. It is
 * pure token waste in model context and buries the one line that matters.
 */
export function stripFfmpegBanner(s: string): string {
  if (!s) return '';
  return s
    .split('\n')
    .filter(line => !(
      /^\s*ffmpeg version\b/i.test(line) ||
      /^\s*built with\b/i.test(line) ||
      /^\s*configuration:/i.test(line) ||
      /^\s*lib(av|sw|postproc)\w*\s+\d+\./i.test(line) ||
      /^\s*Copyright \(c\)/i.test(line)
    ))
    .join('\n');
}

/**
 * Build a tool result carrying BOTH streams, labelled.
 *
 * `stdout || stderr` discarded stderr entirely whenever stdout had a single
 * byte — and ffmpeg, git and most CLI tools write their diagnostics to stderr.
 * That is precisely why the webcam failures were opaque: the capture wrote a
 * byte to stdout and its actual error was thrown away.
 */
export function formatExecResult(
  r: { stdout: string; stderr: string; code: number },
  maxChars: number,
): string {
  const out = stripFfmpegBanner(r.stdout).trim();
  const err = stripFfmpegBanner(r.stderr).trim();

  const parts = [`exit ${r.code}`];
  if (out) parts.push(out);
  if (err) parts.push(`[stderr] ${err}`);
  if (!out && !err) parts.push('(no output)');

  const joined = parts.join('\n');
  return joined.length > maxChars
    ? joined.slice(0, maxChars) + '\n... (truncated)'
    : joined;
}
