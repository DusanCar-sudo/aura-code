// ─────────────────────────────────────────────────────────────────────────────
// list_dir
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from 'fs';
import * as path from 'path';
import { execSync, execFileSync } from 'child_process';
import { IGNORE_PATTERNS } from '../config/defaults.js';

export interface ListDirInput { path: string; recursive: boolean; depth: number }

export function listDir(input: ListDirInput, cwd: string): string {
  const dirPath = path.resolve(cwd, input.path ?? '.');
  if (!fs.existsSync(dirPath)) return `Error: Directory not found: ${input.path}`;

  const lines: string[] = [];
  function walk(dir: string, prefix: string, currentDepth: number) {
    if (currentDepth > input.depth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    const filtered = entries.filter(e => !IGNORE_PATTERNS.some(p => e.name.startsWith('.') ? p === '.git' && e.name === '.git' : e.name === p || e.name.endsWith(p.replace('*', ''))));
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

  let cmd: string;
  const flagsRg: string[] = ['-n', '--no-heading', `--max-count=1`];
  const flagsGrep: string[] = ['-rn', '--include'];

  if (!input.case_sensitive) hasRg ? flagsRg.push('-i') : flagsGrep.push('-i');
  if (input.literal) hasRg ? flagsRg.push('-F') : flagsGrep.push('-F');
  if (input.file_glob) hasRg ? flagsRg.push(`--glob=${input.file_glob}`) : flagsGrep.push(`"${input.file_glob}"`);

  try {
    if (hasRg) {
      cmd = `rg ${flagsRg.join(' ')} ${JSON.stringify(input.pattern)} ${JSON.stringify(searchDir)}`;
    } else {
      cmd = `grep ${flagsGrep.join(' ')} ${JSON.stringify(input.pattern)} ${JSON.stringify(searchDir)}`;
    }
    const result = execSync(cmd, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    const allLines = result.trim().split('\n').filter(Boolean);
    const lines = allLines.slice(0, input.max_results);
    if (lines.length === 0) return `No results for "${input.pattern}"`;
    // Make paths relative
    const relative = lines.map(l => l.replace(searchDir + '/', '').replace(searchDir + path.sep, ''));
    const truncated = allLines.length > lines.length ? ` (showing first ${lines.length} of ${allLines.length})` : '';
    return `Found ${allLines.length} result${allLines.length > 1 ? 's' : ''} for "${input.pattern}"${truncated}:\n\n${relative.join('\n')}`;
  } catch (e: unknown) {
    // Exit code 1 from grep/rg means no results
    if (typeof e === 'object' && e !== null && 'status' in e && (e as { status: number }).status === 1) {
      return `No results for "${input.pattern}"`;
    }
    return `Search error: ${String(e)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// run_shell
// ─────────────────────────────────────────────────────────────────────────────

export interface RunShellInput { command: string; cwd?: string; timeout?: number }

export function runShell(input: RunShellInput, projectCwd: string): string {
  const workDir = input.cwd ? path.resolve(projectCwd, input.cwd) : projectCwd;
  const timeout = input.timeout ?? 30_000;

  try {
    const result = execSync(input.command, {
      cwd: workDir,
      encoding: 'utf8',
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim() || '(command completed with no output)';
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message: string; killed?: boolean; signal?: string };
    // Timeout shows up as either killed=true (with kill) or a SIGTERM/ETIMEDOUT message
    if (err.killed) return `Error: Command timed out after ${timeout}ms`;
    if (/ETIMEDOUT|timeout|timed out/i.test(err.message)) return `Error: Command timed out after ${timeout}ms`;
    const out = [err.stdout?.trim(), err.stderr?.trim()].filter(Boolean).join('\n');
    return out || `Error: ${err.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// run_tests
// ─────────────────────────────────────────────────────────────────────────────

export interface RunTestsInput { file_or_pattern?: string }

export function runTests(input: RunTestsInput, cwd: string): string {
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
