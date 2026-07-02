import * as readline from 'readline';
import { DANGEROUS_PATTERNS, SAFE_SHELL_COMMANDS } from '../config/defaults.js';

export type PermissionLevel = 'read-only' | 'normal' | 'auto';

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  needsConfirm?: boolean;
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
      return { allowed: true };
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

    if (toolName === 'write_file') {
      const path = String(input.path ?? '');
      const key = `write:${path}`;
      if (this.sessionApprovals.has(key)) return { allowed: true };
      return { allowed: true };
    }

    return { allowed: true };
  }

  approveForSession(key: string): void {
    this.sessionApprovals.add(key);
  }

  private isDangerous(cmd: string): boolean {
    return DANGEROUS_PATTERNS.some(p => p.test(cmd));
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
    return SAFE_SHELL_COMMANDS.some(s => lower === s || lower.startsWith(s + ' '));
  }
}

/** Ask user to confirm in the terminal. Returns true if approved. */
export async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`\n⚠️  ${message} [y/N] `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}
