// ─────────────────────────────────────────────────────────────────────────────
// list_dir
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { IGNORE_PATTERNS } from '../config/defaults.js';
import { resolveInRoot, PathJailError } from '../safety/path-jail.js';
import { rtkWrap } from '../util/rtk.js';

// Everything that shells out here is async. The sync execs this module used to
// use blocked the event loop for the whole command — and with the TUI living in
// the same process, a long run_shell (a build, a test suite, npm install) froze
// the spinner, the keyboard and all streaming output until the command ended.
interface ExecResult { stdout: string; stderr: string; code: number; timedOut: boolean }

function execAsync(command: string, opts: { cwd?: string; timeout?: number; maxBuffer?: number }): Promise<ExecResult> {
  return new Promise(resolve => {
    exec(command, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer ?? 2 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const e = err as (Error & { killed?: boolean; code?: number | string }) | null;
      // killed is set exactly when the timeout fired; sniffing the message for
      // "timeout" misfires on unrelated text (node stack frames like
      // listOnTimeout, a file named timeout.go, …).
      const timedOut = Boolean(e?.killed);
      resolve({
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        // A process that exited non-zero carries its exit code in err.code; a
        // spawn failure (ENOENT) has none and lands as 1 so callers treat it
        // as an ordinary failure.
        code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
        timedOut,
      });
    });
  });
}

/** ripgrep availability, probed once per process. `where` on Windows, `which` elsewhere. */
let rgProbe: Promise<boolean> | null = null;
function probeRg(): Promise<boolean> {
  if (!rgProbe) {
    rgProbe = execAsync(process.platform === 'win32' ? 'where rg' : 'which rg', { timeout: 5000 })
      .then(r => r.code === 0 && r.stdout.trim().length > 0)
      .catch(() => false);
  }
  return rgProbe;
}

export interface ListDirInput { path: string; recursive: boolean; depth: number }

export function listDir(input: ListDirInput, cwd: string): string {
  let dirPath: string;
  try { dirPath = resolveInRoot(cwd, input.path ?? '.'); }
  catch (e) { if (e instanceof PathJailError) return `Error: ${e.message}`; throw e; }
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
  let filePath: string;
  try { filePath = resolveInRoot(cwd, input.path); }
  catch (e) { if (e instanceof PathJailError) return `Error: ${e.message}`; throw e; }
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

export async function searchCode(input: SearchCodeInput, cwd: string): Promise<string> {
  let searchDir: string;
  try { searchDir = resolveInRoot(cwd, input.path ?? '.'); }
  catch (e) { if (e instanceof PathJailError) return `Error: ${e.message}`; throw e; }

  // Try ripgrep first (much faster), fall back to grep
  const hasRg = await probeRg();

  let cmd: string;
  const flagsRg: string[] = ['-n', '--no-heading', `--max-count=1`];
  const flagsGrep: string[] = ['-rn'];

  if (!input.case_sensitive) hasRg ? flagsRg.push('-i') : flagsGrep.push('-i');
  if (input.literal) hasRg ? flagsRg.push('-F') : flagsGrep.push('-F');
  if (input.file_glob) hasRg ? flagsRg.push(`--glob=${input.file_glob}`) : flagsGrep.push(`--include=${JSON.stringify(input.file_glob)}`);

  if (hasRg) {
    cmd = `rg ${flagsRg.join(' ')} ${JSON.stringify(input.pattern)} ${JSON.stringify(searchDir)}`;
  } else {
    cmd = `grep ${flagsGrep.join(' ')} ${JSON.stringify(input.pattern)} ${JSON.stringify(searchDir)}`;
  }
  const r = await execAsync(cmd, { maxBuffer: 2 * 1024 * 1024, timeout: 60_000 });
  // Exit code 1 from grep/rg means no results
  if (r.code === 1) return `No results for "${input.pattern}"`;
  if (r.code !== 0) {
    return `Search error: ${(r.stderr || r.stdout || `search exited with code ${r.code}`).trim().slice(0, 500)}`;
  }
  const allLines = r.stdout.trim().split('\n').filter(Boolean);
  const lines = allLines.slice(0, input.max_results);
  if (lines.length === 0) return `No results for "${input.pattern}"`;
  // Make paths relative. Clip each matched line: a match inside a minified
  // file (one 1.2 MB line in graphify-out/dashboard.html) once dumped ~340k
  // tokens into history in a single tool result and poisoned the context
  // for the rest of the session.
  const MAX_LINE_CHARS = 500;
  const clipped = lines.map(l => {
    const rel = l.replace(searchDir + '/', '').replace(searchDir + path.sep, '');
    return rel.length > MAX_LINE_CHARS ? rel.slice(0, MAX_LINE_CHARS) + ' …[line clipped]' : rel;
  });
  // Total-budget guard on top of the per-line one: 50 matches at up to 500
  // chars each is ~25 KB of context for a tool whose only job is to point at
  // the right lines — the model re-reads the interesting files in ranges.
  const MAX_TOTAL_CHARS = 12_000;
  const kept: string[] = [];
  let used = 0;
  for (const l of clipped) {
    if (kept.length > 0 && used + l.length > MAX_TOTAL_CHARS) break;
    kept.push(l);
    used += l.length;
  }
  const reasons: string[] = [];
  if (allLines.length > lines.length) reasons.push(`showing first ${lines.length} of ${allLines.length} matches`);
  const cutByBudget = lines.length - kept.length;
  if (cutByBudget > 0) reasons.push(`${cutByBudget} more cut at the ${MAX_TOTAL_CHARS / 1000}K-char cap — narrow the pattern or glob`);
  const note = reasons.length > 0 ? ` (${reasons.join('; ')})` : '';
  return `Found ${allLines.length} result${allLines.length > 1 ? 's' : ''} for "${input.pattern}"${note}:\n\n${kept.join('\n')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// run_shell
// ─────────────────────────────────────────────────────────────────────────────

export interface RunShellInput { command: string; cwd?: string; timeout?: number }

function truncateOutput(output: string, isError: boolean): string {
  const MAX_LEN = isError ? 4000 : 2000;
  if (!output || output.length <= MAX_LEN) return output;
  const head = 500;
  const tail = isError ? 3000 : 1000;
  const truncated = output.length - head - tail;
  return `${output.slice(0, head)}\n\n... [ TRUNCATED ${truncated} BYTES ] ...\n\n${output.slice(-tail)}`;
}

export async function runShell(input: RunShellInput, projectCwd: string): Promise<string> {
  let workDir: string;
  try { workDir = input.cwd ? resolveInRoot(projectCwd, input.cwd) : projectCwd; }
  catch (e) { if (e instanceof PathJailError) return `Error: ${e.message}`; throw e; }
  const timeout = input.timeout ?? 30_000;

  // Through RTK when it's installed — its compressed output is what keeps a
  // long session's context from filling with raw terminal noise.
  const r = await execAsync(rtkWrap(input.command), { cwd: workDir, timeout, maxBuffer: 2 * 1024 * 1024 });
  if (r.timedOut) return `Error: Command timed out after ${timeout}ms`;
  if (r.code === 0) {
    const output = r.stdout.trim() || '(command completed with no output)';
    return truncateOutput(output, false);
  }
  const outStdout = truncateOutput(r.stdout.trim(), true);
  const outStderr = truncateOutput(r.stderr.trim(), true);
  const out = [outStdout, outStderr].filter(Boolean).join('\n');
  return out || `Error: command exited with code ${r.code}`;
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

export async function gitStatus(cwd: string): Promise<string> {
  const opts = { cwd, timeout: 15_000 };
  const [status, log, branch] = await Promise.all([
    execAsync(rtkWrap('git status --short'), opts),
    execAsync(rtkWrap('git log --oneline -5'), opts),
    execAsync(rtkWrap('git branch --show-current'), opts),
  ]);
  if (branch.code !== 0) return 'Not a git repository (or git not installed)';
  const st = status.stdout.trim();
  return [
    `Branch: ${branch.stdout.trim()}`,
    '',
    st ? `Changed files:\n${st}` : 'Working tree clean',
    '',
    `Recent commits:\n${log.stdout.trim()}`,
  ].join('\n');
}

export interface GitDiffInput { path?: string; staged: boolean }

export async function gitDiff(input: GitDiffInput, cwd: string): Promise<string> {
  const staged = input.staged ? '--staged ' : '';
  const file   = input.path ? `-- ${JSON.stringify(input.path)}` : '';
  const r = await execAsync(rtkWrap(`git diff ${staged}${file}`), { cwd, timeout: 30_000 });
  if (r.code !== 0 && !r.stdout) return `Git error: ${(r.stderr || `git exited with code ${r.code}`).slice(0, 2000)}`;
  const text = r.stdout.trim();
  if (!text) return `No ${input.staged ? 'staged ' : ''}changes${input.path ? ` in ${input.path}` : ''}`;
  // A whole-tree diff runs to hundreds of KB. Cap it here with a head + tail
  // window: the loop's own cap would keep only the head, silently dropping
  // every hunk near the bottom of the diff the model had not read yet.
  const MAX_DIFF_CHARS = 20_000;
  const TAIL_CHARS = 8_000;
  if (text.length > MAX_DIFF_CHARS) {
    const head = text.slice(0, MAX_DIFF_CHARS - TAIL_CHARS);
    const tail = text.slice(-TAIL_CHARS);
    return `${head}\n\n... [truncated: ${(text.length - MAX_DIFF_CHARS).toLocaleString()} chars omitted — diff a file or directory in smaller pieces] ...\n\n${tail}`;
  }
  return text;
}
