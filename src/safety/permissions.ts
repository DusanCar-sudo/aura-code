import * as fs from 'fs';
import * as path from 'path';
import readline from 'readline';
import {
  DANGEROUS_PATTERNS, SAFE_SHELL_COMMANDS,
  BLOCKED_TRAVERSAL_PATHS, FUSE_MOUNT_PATTERN,
} from '../config/defaults.js';

export type PermissionLevel = 'read-only' | 'normal' | 'auto';

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  needsConfirm?: boolean;
}

export interface PermissionConfig {
  allowedMountPaths?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// ShellCommandValidator — prevents recursive commands from traversing into
// unresponsive FUSE/network mounts where I/O can cause D-state hangs.
// ─────────────────────────────────────────────────────────────────────────────

/** Extract search-path arguments from find/grep/rg command strings. */
function extractSearchPaths(base: string, args: string[]): string[] {
  if (base === 'find') {
    // find [path] [expression] — first non-flag arg is the search path
    for (const a of args) {
      if (!a.startsWith('-') && a !== '!' && a !== '(' && a !== ')') return [a];
    }
    return ['.'];
  }
  // grep / rg: look for paths after --, or the last non-flag arg that looks like a path
  const paths: string[] = [];
  let afterDoubleDash = false;
  for (const a of args) {
    if (a === '--') { afterDoubleDash = true; continue; }
    if (afterDoubleDash && !a.startsWith('-')) { paths.push(a); continue; }
    // Flags with values: skip the value part
    if (a === '-e' || a === '-f' || a === '--regexp' || a === '--file') continue;
    if (a.startsWith('--max-count') || a.startsWith('--glob') || a.startsWith('--include') || a.startsWith('--exclude')) continue;
    if (a.startsWith('-') || a === '--') continue;
    // Only for -r/-R (recursive) commands — collect potential path args
    paths.push(a);
  }
  return paths.length > 0 ? paths : [];
}

/** Detect whether a recursive search command targets a given path. */
function hasRecursiveFlag(args: string[]): boolean {
  return args.some(a =>
    a === '-r' || a === '-R' || a === '--recursive' ||
    (a.startsWith('-') && !a.startsWith('--') && (a.includes('r') || a.includes('R'))),
  );
}

export class ShellCommandValidator {
  private blockedPrefixes: string[];

  constructor() {
    // Merge static blocklist with dynamically discovered FUSE mounts
    this.blockedPrefixes = [...BLOCKED_TRAVERSAL_PATHS];
    this.discoverFuseMounts();
  }

  private discoverFuseMounts(): void {
    try {
      const mounts = fs.readFileSync('/proc/mounts', 'utf8');
      for (const line of mounts.split('\n')) {
        const parts = line.split(' ');
        if (parts.length >= 3 && FUSE_MOUNT_PATTERN.test(parts[2])) {
          const mountPoint = parts[1];
          if (mountPoint && !mountPoint.endsWith('/')) {
            this.blockedPrefixes.push(mountPoint + '/');
          } else if (mountPoint) {
            this.blockedPrefixes.push(mountPoint);
          }
        }
      }
    } catch {
      // /proc/mounts not available (non-Linux, permissions) — static list only
    }
  }

  validateCommand(cmd: string, projectRoot: string, config?: PermissionConfig): { allowed: boolean; reason?: string } {
    const tokens = tokenize(cmd);
    if (tokens.length === 0) return { allowed: true };

    const base = path.basename(tokens[0]);
    if (!['find', 'grep', 'rg'].includes(base)) return { allowed: true };

    // rg is recursive by default; grep/find require explicit -r flag
    const isRecursive = base === 'find' || base === 'rg' || hasRecursiveFlag(tokens.slice(1));
    if (!isRecursive) return { allowed: true };

    const searchPaths = extractSearchPaths(base, tokens.slice(1));
    const normalizedRoot = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
    const allowed = config?.allowedMountPaths ?? [];

    for (const raw of searchPaths) {
      // Expand ~ to HOME
      const expanded = raw === '~' || raw.startsWith('~/')
        ? path.join(process.env.HOME ?? '/tmp', raw.slice(1))
        : raw;

      const resolved = path.resolve(projectRoot, expanded);
      const normalizedResolved = resolved.endsWith('/') ? resolved : resolved + '/';

      // 1) Check blocked mount prefixes first — allowedMountPaths override both
      //    the mount block AND the root boundary (user explicitly opted in).
      let whitelisted = false;
      for (const prefix of this.blockedPrefixes) {
        if (normalizedResolved.startsWith(prefix)) {
          const isExplicitlyAllowed = allowed.some(a => {
            const normAllowed = a.endsWith('/') ? a : a + '/';
            return normalizedResolved.startsWith(normAllowed);
          });
          if (isExplicitlyAllowed) { whitelisted = true; break; }
          return {
            allowed: false,
            reason: `Blocked: '${base}' would traverse into '${raw}' which matches a ` +
              `blocked mount prefix (${prefix}). This can cause hangs on unresponsive ` +
              `FUSE/network filesystems. Add '${raw}' to allowedMountPaths in .aura.json ` +
              `to override.`,
          };
        }
      }

      // 2) Must be inside project root (skip if explicitly whitelisted above)
      if (!whitelisted && !normalizedResolved.startsWith(normalizedRoot) && normalizedResolved !== normalizedRoot) {
        return {
          allowed: false,
          reason: `Blocked: '${base}' search path '${raw}' resolves outside project root (${projectRoot}). ` +
            `To search outside the project, run the command directly in your terminal.`,
        };
      }
    }

    return { allowed: true };
  }
}

/**
 * Minimal shell tokenizer that handles quotes and backslash escapes.
 * Splits a command string into tokens without invoking a shell.
 */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (const ch of cmd) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && !inSingle) { escape = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current.length > 0) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// PermissionSystem
// ─────────────────────────────────────────────────────────────────────────────

export class PermissionSystem {
  private level: PermissionLevel;
  private sessionApprovals = new Set<string>();
  private validator: ShellCommandValidator;
  private projectRoot: string;
  private config?: PermissionConfig;

  constructor(level: PermissionLevel = 'normal', projectRoot?: string, config?: PermissionConfig) {
    this.level = level;
    this.projectRoot = projectRoot ?? process.cwd();
    this.config = config;
    this.validator = new ShellCommandValidator();
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
        const scopeCheck = this.validator.validateCommand(cmd, this.projectRoot, this.config);
        if (!scopeCheck.allowed) return scopeCheck;
      }
      return { allowed: true };
    }

    // Normal mode: safe ops auto-approved, destructive need confirm
    if (toolName === 'run_shell') {
      const cmd = String(input.command ?? '');
      if (this.isDangerous(cmd)) {
        return { allowed: false, reason: `Dangerous command blocked: ${cmd}` };
      }
      const scopeCheck = this.validator.validateCommand(cmd, this.projectRoot, this.config);
      if (!scopeCheck.allowed) return scopeCheck;
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
    const lower = cmd.toLowerCase().trim();
    return SAFE_SHELL_COMMANDS.some(s => lower.startsWith(s));
  }
}

/** Ask user to confirm in the terminal. Returns true if approved. */
export async function confirm(message: string): Promise<boolean> {
  process.stdout.write(`\n⚠️  ${message} [y/N] `);
  // Temporarily remove existing stdin data listeners (e.g. from REPL readline)
  // to ensure only ONE reader is active at a time — prevents input doubling.
  const existingListeners = process.stdin.rawListeners('data') as Array<(...args: any[]) => void>;
  for (const listener of existingListeners) {
    process.stdin.removeListener('data', listener);
  }
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', (answer) => {
      rl.close();
      // Restore original listeners so REPL readline continues working
      for (const listener of existingListeners) {
        process.stdin.on('data', listener);
      }
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}
