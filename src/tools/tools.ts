// ─────────────────────────────────────────────────────────────────────────────
// list_dir
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from 'fs';
import * as path from 'path';
import { execSync, execFileSync, spawn } from 'child_process';
import { IGNORE_PATTERNS } from '../config/defaults.js';

export interface ListDirInput { path: string; recursive: boolean; depth: number }

/** Match a filename against a simple glob pattern (supports leading/trailing *). */
function matchGlob(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return name === pattern;
  if (pattern === '*') return true;
  if (pattern.startsWith('*') && pattern.endsWith('*')) return name.includes(pattern.slice(1, -1));
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  // Multiple wildcards: check prefix and suffix
  const firstStar = pattern.indexOf('*');
  const lastStar = pattern.lastIndexOf('*');
  if (firstStar !== lastStar) {
    const prefix = pattern.substring(0, firstStar);
    const suffix = pattern.substring(lastStar + 1);
    return name.startsWith(prefix) && name.endsWith(suffix);
  }
  return name === pattern;
}


export function listDir(input: ListDirInput, cwd: string): string {
  const dirPath = path.resolve(cwd, input.path ?? '.');
  if (!fs.existsSync(dirPath)) return `Error: Directory not found: ${input.path}`;

  const lines: string[] = [];
  function walk(dir: string, prefix: string, currentDepth: number) {
    if (currentDepth > input.depth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    const filtered = entries.filter(e => !IGNORE_PATTERNS.some(p => matchGlob(e.name, p)));
    filtered.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < filtered.length; i++) {
      const e = filtered[i];
      const isLast = i === filtered.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? prefix + '    ' : prefix + '│   ';
      lines.push(`${prefix}${connector}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory() && input.recursive) walk(path.join(dir, e.name), childPrefix, currentDepth + 1);
    }
  }

  const rel = path.relative(cwd, dirPath) || '.';
  lines.push(rel + '/');
  walk(dirPath, '', 1);

  if (lines.length > 200) {
    return lines.slice(0, 200).join('\n') + `\n\n... (${lines.length - 200} more entries — use a more specific path)`;
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// write_file
// ─────────────────────────────────────────────────────────────────────────────

export interface WriteFileInput { path: string; content: string }

export function writeFile(input: WriteFileInput, cwd: string): string {
  const filePath = path.resolve(cwd, input.path);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(filePath);
  fs.writeFileSync(filePath, input.content, 'utf8');
  const lines = input.content.split('\n').length;
  return `✓ ${existed ? 'Overwrote' : 'Created'} ${input.path} (${lines} lines)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// search_code
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchCodeInput {
  pattern: string;
  path?: string;
  file_glob?: string;
  literal: boolean;
  case_sensitive: boolean;
  max_results: number;
}

export function searchCode(input: SearchCodeInput, cwd: string): string {
  const searchDir = path.resolve(cwd, input.path ?? '.');

  // Try ripgrep first (much faster), fall back to grep
  const hasRg = (() => { try { execSync('which rg', { stdio: 'pipe' }); return true; } catch { return false; } })();

  const flagsRg: string[] = ['-n', '--no-heading', '--max-count=1'];
  const flagsGrep: string[] = ['-rn'];

  if (!input.case_sensitive) { if (hasRg) flagsRg.push('-i'); else flagsGrep.push('-i'); }
  if (input.literal) { if (hasRg) flagsRg.push('-F'); else flagsGrep.push('-F'); }
  if (input.file_glob) { if (hasRg) flagsRg.push('--glob=' + input.file_glob); else flagsGrep.push('--include', input.file_glob); }

  try {
    if (hasRg) {
      // Use execFileSync with args array to avoid shell injection
      const result = execFileSync('rg', flagsRg.concat([input.pattern, searchDir]), {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      });
      const allLines = result.trim() ? result.trim().split('\n').filter(Boolean) : [];
      const lines = allLines.slice(0, input.max_results);
      if (lines.length === 0) return 'No results for "' + input.pattern + '"';
      const relative = lines.map(l => l.replace(searchDir + '/', '').replace(searchDir + path.sep, ''));
      const truncated = allLines.length > lines.length ? ' (showing first ' + lines.length + ' of ' + allLines.length + ')' : '';
      return 'Found ' + allLines.length + ' result' + (allLines.length > 1 ? 's' : '') + ' for "' + input.pattern + '"' + truncated + ':\n\n' + relative.join('\n');
    } else {
      const result = execFileSync('grep', flagsGrep.concat(['--', input.pattern, searchDir]), {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      });
      const allLines = result.trim() ? result.trim().split('\n').filter(Boolean) : [];
      const lines = allLines.slice(0, input.max_results);
      if (lines.length === 0) return 'No results for "' + input.pattern + '"';
      const relative = lines.map(l => l.replace(searchDir + '/', '').replace(searchDir + path.sep, ''));
      const truncated = allLines.length > lines.length ? ' (showing first ' + lines.length + ' of ' + allLines.length + ')' : '';
      return 'Found ' + allLines.length + ' result' + (allLines.length > 1 ? 's' : '') + ' for "' + input.pattern + '"' + truncated + ':\n\n' + relative.join('\n');
    }
  } catch (e: unknown) {
    // Exit code 1 from grep/rg means no results
    if (typeof e === 'object' && e !== null && 'status' in e && (e as { status: number }).status === 1) {
      return 'No results for "' + input.pattern + '"';
    }
    return 'Search error: ' + String(e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// run_shell
// ─────────────────────────────────────────────────────────────────────────────

export interface RunShellInput { command: string; cwd?: string; timeout?: number }

/**
 * Run a shell command with SIGKILL escalation on timeout.
 *
 * Uses `spawn` with `detached: true` so the child gets its own process group.
 * On timeout: SIGTERM is sent to the process group; after a grace period,
 * SIGKILL follows. This handles processes that trap or ignore SIGTERM.
 *
 * NOTE: Even SIGKILL cannot terminate a true D-state process blocked on
 * hardware/network I/O (e.g. an unresponsive FUSE mount). That is a Linux
 * kernel limitation — the real fix is preventing traversal into such paths
 * (see BLOCKED_TRAVERSAL_PATHS in config/defaults.ts).
 */
export async function runShell(input: RunShellInput, projectCwd: string): Promise<string> {
  const workDir = input.cwd ? path.resolve(projectCwd, input.cwd) : projectCwd;
  const timeout = input.timeout ?? 30_000;
  const SIGKILL_GRACE_MS = 2_000;
  const MAX_BUFFER = 2 * 1024 * 1024;

  return new Promise<string>((resolve) => {
    const proc = spawn(input.command, {
      shell: true,
      detached: true,
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let exceededBuffer = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      if (!exceededBuffer) {
        stdout += chunk.toString();
        if (stdout.length > MAX_BUFFER) exceededBuffer = true;
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (!exceededBuffer) {
        stderr += chunk.toString();
        if (stderr.length > MAX_BUFFER) exceededBuffer = true;
      }
    });

    // Timeout → SIGTERM → grace → SIGKILL
    const timer = setTimeout(() => {
      try { process.kill(-proc.pid!, 'SIGTERM'); } catch { /* already dead */ }
      const grace = setTimeout(() => {
        try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* already dead */ }
      }, SIGKILL_GRACE_MS);
      proc.on('exit', () => clearTimeout(grace));
    }, timeout);

    proc.on('exit', (code, signal) => {
      clearTimeout(timer);

      if (exceededBuffer) {
        resolve(`Error: Output exceeded ${MAX_BUFFER} bytes`);
        return;
      }
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        resolve(`Error: Command timed out after ${timeout}ms`);
        return;
      }
      if (code !== 0 && stderr.trim()) {
        resolve(stderr.trim());
        return;
      }
      resolve(stdout.trim() || '(command completed with no output)');
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve(`Error: ${err.message}`);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// run_tests
// ─────────────────────────────────────────────────────────────────────────────

export interface RunTestsInput { file_or_pattern?: string }

export async function runTests(input: RunTestsInput, cwd: string): Promise<string> {
  // Detect test framework
  let testCmd = detectTestCommand(cwd, input.file_or_pattern);
  return runShell({ command: testCmd, timeout: 60_000 }, cwd);
}

function detectTestCommand(cwd: string, fileOrPattern?: string): string {
  const pkg = path.join(cwd, 'package.json');
  if (fs.existsSync(pkg)) {
    const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    const scripts = p.scripts ?? {};
    const deps = { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) };
    const pat = fileOrPattern ? ` ${JSON.stringify(fileOrPattern)}` : '';
    if (deps.vitest || scripts.test?.includes('vitest')) return `npx vitest run${pat}`;
    if (deps.jest || scripts.test?.includes('jest')) return `npx jest${pat}`;
    if (scripts.test) return `npm test${fileOrPattern ? ` -- ${fileOrPattern}` : ''}`;
  }
  if (fs.existsSync(path.join(cwd, 'pytest.ini')) || fs.existsSync(path.join(cwd, 'setup.py'))) {
    return `python -m pytest${fileOrPattern ? ` ${fileOrPattern}` : ''} -v`;
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return `go test${fileOrPattern ? ` ${fileOrPattern}` : ' ./...'}`;
  }
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return `cargo test${fileOrPattern ? ` ${fileOrPattern}` : ''}`;
  }
  return 'npm test';
}

// ─────────────────────────────────────────────────────────────────────────────
// git tools
// ─────────────────────────────────────────────────────────────────────────────

export function gitStatus(cwd: string): string {
  try {
    const status = execSync('git status --short', { cwd, encoding: 'utf8' }).trim();
    const log    = execSync('git log --oneline -5', { cwd, encoding: 'utf8' }).trim();
    const branch = execSync('git branch --show-current', { cwd, encoding: 'utf8' }).trim();
    return [
      `Branch: ${branch}`,
      '',
      status ? `Changed files:\n${status}` : 'Working tree clean',
      '',
      `Recent commits:\n${log}`,
    ].join('\n');
  } catch { return 'Not a git repository (or git not installed)'; }
}

export interface GitDiffInput { path?: string; staged: boolean }

export function gitDiff(input: GitDiffInput, cwd: string): string {
  try {
    const staged = input.staged ? '--staged ' : '';
    const file   = input.path ? `-- ${JSON.stringify(input.path)}` : '';
    const diff   = execSync(`git diff ${staged}${file}`, { cwd, encoding: 'utf8' });
    return diff.trim() || `No ${input.staged ? 'staged ' : ''}changes${input.path ? ` in ${input.path}` : ''}`;
  } catch (e) { return `Git error: ${String(e)}`; }
}
