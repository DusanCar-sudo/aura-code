import * as readline from 'readline';
import {
  DANGEROUS_PATTERNS, SAFE_SHELL_COMMANDS,
  WINDOWS_DANGEROUS_PATTERNS, WINDOWS_SAFE_SHELL_COMMANDS,
} from '../config/defaults.js';

// Screened together on every platform. See WINDOWS_DANGEROUS_PATTERNS for why
// this is not switched on process.platform: the running shell is a poor proxy
// for which syntax can reach the OS once Git Bash and WSL are in play, and the
// other platform's syntax is inert anyway.
const ALL_DANGEROUS = [...DANGEROUS_PATTERNS, ...WINDOWS_DANGEROUS_PATTERNS];
const ALL_SAFE = [...SAFE_SHELL_COMMANDS, ...WINDOWS_SAFE_SHELL_COMMANDS];

export type PermissionLevel = 'read-only' | 'normal' | 'auto';

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  needsConfirm?: boolean;
  /**
   * Set when an approval should be remembered for the rest of the run.
   *
   * The caller passes it back to [approveForSession] once the user says yes,
   * so the same target is not asked about twice. Without it a task that writes
   * one file over several turns would prompt on every turn.
   */
  approvalKey?: string;
}

export class PermissionSystem {
  private level: PermissionLevel;
  private sessionApprovals = new Set<string>();

  constructor(level: PermissionLevel = 'normal') {
    this.level = level;
  }

  check(toolName: string, input: Record<string, unknown>): PermissionResult {
    // Read-only mode: only allow read operations
    if (this.level === 'read-only') {
      const readOnly = ['read_file', 'list_dir', 'search_code', 'git_status', 'git_diff'];
      if (!readOnly.includes(toolName)) {
        return { allowed: false, reason: `Tool '${toolName}' not allowed in read-only mode` };
      }
      return { allowed: true };
    }

    // Auto mode: allow everything except explicitly dangerous
    if (this.level === 'auto') {
      if (toolName === 'run_shell') {
        const cmd = String(input.command ?? '');
        if (this.isDangerous(cmd)) {
          return { allowed: false, reason: `Dangerous command blocked: ${cmd}` };
        }
      }
      if (toolName === 'mcp' && String(input.action ?? '') === 'connect') {
        const cmd = this.mcpConnectCommand(input);
        if (this.isDangerous(cmd)) {
          return { allowed: false, reason: `Dangerous command blocked: ${cmd}` };
        }
      }
      return { allowed: true };
    }

    // mcp 'connect' spawns an arbitrary external server process — the same
    // trust boundary as run_shell, so it gets the same dangerous-pattern
    // screen plus an unconditional confirm (a server spawn is never on the
    // safe list; once connected, its tools run without further prompts).
    if (toolName === 'mcp' && String(input.action ?? '') === 'connect') {
      const cmd = this.mcpConnectCommand(input);
      if (this.isDangerous(cmd)) {
        return { allowed: false, reason: `Dangerous command blocked: ${cmd}` };
      }
      return { allowed: true, needsConfirm: true };
    }

    // Normal mode: safe ops auto-approved, destructive need confirm
    if (toolName === 'run_shell') {
      const cmd = String(input.command ?? '');
      if (this.isDangerous(cmd)) {
        return { allowed: false, reason: `Dangerous command blocked: ${cmd}` };
      }
      if (!this.isSafe(cmd)) {
        return { allowed: true, needsConfirm: true };
      }
    }

    // Writing a file is destructive — it overwrites whatever was there — and
    // this was returning plain `allowed` on both branches, so the session
    // lookup below decided nothing and no write was ever confirmed. The intent
    // is visible either side of it: the lookup itself, and the `overwrite
    // <path>` string in the agent loop's formatCallForConfirmation, which had
    // no way to ever be displayed.
    //
    // Keyed by path so a task editing one file over several turns asks once,
    // not once per turn.
    if (toolName === 'write_file') {
      const path = String(input.path ?? '');
      const key = `write:${path}`;
      if (this.sessionApprovals.has(key)) return { allowed: true };
      return { allowed: true, needsConfirm: true, approvalKey: key };
    }

    return { allowed: true };
  }

  approveForSession(key: string): void {
    this.sessionApprovals.add(key);
  }

  /** Current enforcement level. */
  getLevel(): PermissionLevel {
    return this.level;
  }

  /**
   * Change the level at runtime — used by the REPL `:approve` command to flip
   * a session into auto-approve (no per-command confirm) and back. Dangerous
   * commands are STILL blocked in 'auto'; this only removes the y/N prompt for
   * ordinary destructive-but-safe operations.
   */
  setLevel(level: PermissionLevel): void {
    this.level = level;
  }

  private mcpConnectCommand(input: Record<string, unknown>): string {
    const args = Array.isArray(input.args_list) ? input.args_list.join(' ') : '';
    return `${String(input.command ?? '')} ${args}`.trim();
  }

  private isDangerous(cmd: string): boolean {
    return ALL_DANGEROUS.some(p => p.test(cmd));
  }

  private isSafe(cmd: string): boolean {
    const trimmed = cmd.trim();

    // A command containing shell control operators can't be judged safe from
    // its prefix alone — `cat x; python3 -c '…'` starts with a safe command
    // but chains an interpreter. Force confirmation for anything with
    // chaining (`;` `&` `|`), redirection (`>` `<`), or command substitution
    // (`$(…)`, backticks). This is the structural fix for prefix-smuggling.
    if (/[;&|<>`]/.test(trimmed) || trimmed.includes('$(')) return false;

    const lower = trimmed.toLowerCase();
    // Anchor to a whole-command match so `curlx …` doesn't match `curl` and
    // `lscpu` doesn't match `ls`.
    return ALL_SAFE.some(s => lower === s || lower.startsWith(s + ' '));
  }
}

// Shared readline from the interactive REPL. confirm() must reuse it when
// set: a second interface on the same stdin echoes every keypress twice, and
// closing it pauses stdin without the REPL's interface knowing — its next
// prompt never resumes the stream, the event loop drains, and the process
// exits right after printing the prompt.
let sharedRl: readline.Interface | null = null;

export function setSharedReadline(rl: readline.Interface | null): void {
  sharedRl = rl;
}

export function getSharedReadline(): readline.Interface | null {
  return sharedRl;
}

// The TUI owns stdin in raw mode via its own 'data' handler — a plain
// readline.Interface (below) forces stdin out of raw mode the moment it
// attaches and never restores it, so a confirm() prompt during TUI mode
// used to fight the TUI's own input handling for every keystroke (garbled
// echo, dropped characters, leftover fragments on screen). setSharedReadline
// was meant to prevent a *second* readline.Interface, but the TUI doesn't
// use readline at all — it needs its own raw-mode-safe prompt. cli/index.ts
// registers one via setConfirmHandler() when TUI mode starts; confirm()
// prefers it over readline whenever it's set.
let confirmHandler: ConfirmHandler | null = null;

/**
 * Structured description of what is being approved, alongside the rendered
 * prose. Terminal handlers only need the message; a remote client (the
 * protocol's approval.request) needs the tool name and arguments so it can
 * render a real modal and offer "always allow this tool" — deriving those by
 * regexing the prose is guesswork, and the prose is formatted for humans
 * ("$ npm install", "overwrite /path/x").
 *
 * Optional so every existing caller and handler keeps working unchanged.
 */
export interface ConfirmContext {
  toolName: string;
  input: Record<string, unknown>;
}

export type ConfirmHandler = (message: string, ctx?: ConfirmContext) => Promise<boolean>;

export function setConfirmHandler(fn: ConfirmHandler | null): void {
  confirmHandler = fn;
}

/** Ask user to confirm in the terminal. Returns true if approved. */
export async function confirm(message: string, ctx?: ConfirmContext): Promise<boolean> {
  if (confirmHandler) return confirmHandler(message, ctx);
  const rl = sharedRl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`\n⚠️  ${message} [y/N] `, answer => {
      if (rl !== sharedRl) rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}
