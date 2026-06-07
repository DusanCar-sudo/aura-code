import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { Check } from './types.js';

export interface CheckContext {
  projectRoot: string;
  taskStartedAt: number;
  task: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  filesBefore: Set<string>;
  testCommand?: string;
  baselineFailures?: Set<string>;
}

const MTIME_SLACK_MS = 50;

export function runAllChecks(ctx: CheckContext): Check[] {
  const checks: Check[] = [];

  const fileWrites = ctx.toolCalls.filter(c => c.name === 'write_file');
  const fileEdits  = ctx.toolCalls.filter(c => c.name === 'edit_file');
  const shellCalls = ctx.toolCalls.filter(c => c.name === 'run_shell');
  const hadWrite   = fileWrites.length > 0;
  const hadEdit    = fileEdits.length > 0;

  if (hadWrite) checks.push(...verifyWrittenFiles(ctx, fileWrites));
  if (hadEdit)  checks.push(...verifyEditedFiles(ctx, fileEdits));

  const testCmdAlreadyRan = ctx.testCommand
    && shellCalls.some(c => String(c.input.command ?? '').includes(ctx.testCommand!));
  if (ctx.testCommand && !testCmdAlreadyRan) checks.push(...runTestCommand(ctx));

  checks.push(...verifyShellTests(ctx, shellCalls));
  checks.push(...verifyTaskIntent(ctx));

  return checks;
}

function verifyWrittenFiles(
  ctx: CheckContext,
  calls: Array<{ name: string; input: Record<string, unknown> }>,
): Check[] {
  const checks: Check[] = [];
  const minBytes = 100;

  for (const call of calls) {
    const filePath = String(call.input.path ?? '');
    if (!filePath) continue;
    const abs = path.resolve(ctx.projectRoot, filePath);

    if (!fs.existsSync(abs)) {
      checks.push({
        name: 'file exists',
        passed: false,
        detail: `${filePath} — not found`,
      });
    } else {
      try {
        const stat = fs.statSync(abs);
        if (stat.size < minBytes) {
          checks.push({
            name: 'file size',
            passed: false,
            detail: `${filePath} — ${stat.size} bytes (< ${minBytes} minimum)`,
          });
        } else {
          checks.push({
            name: 'file exists',
            passed: true,
            detail: `${filePath} — ${stat.size} bytes`,
          });
        }
      } catch {
        checks.push({ name: 'file exists', passed: false, detail: `${filePath} — stat failed` });
      }
    }
  }
  return checks;
}

function verifyEditedFiles(
  ctx: CheckContext,
  calls: Array<{ name: string; input: Record<string, unknown> }>,
): Check[] {
  const checks: Check[] = [];

  for (const call of calls) {
    const filePath = String(call.input.path ?? '');
    if (!filePath) continue;
    const abs = path.resolve(ctx.projectRoot, filePath);

    if (!fs.existsSync(abs)) {
      checks.push({ name: 'file mtime', passed: false, detail: `${filePath} — does not exist` });
      continue;
    }

    try {
      const stat = fs.statSync(abs);
      if (stat.mtimeMs > ctx.taskStartedAt - MTIME_SLACK_MS) {
        checks.push({ name: 'file mtime', passed: true, detail: `${filePath} — modified` });
      } else {
        checks.push({
          name: 'file mtime',
          passed: false,
          detail: `${filePath} — not modified (mtime: ${new Date(stat.mtimeMs).toISOString()})`,
        });
      }
    } catch {
      checks.push({ name: 'file mtime', passed: false, detail: `${filePath} — stat failed` });
    }
  }
  return checks;
}

function runTestCommand(ctx: CheckContext): Check[] {
  if (!ctx.testCommand) return [];
  const baselineFailures = ctx.baselineFailures ?? new Set<string>();

  try {
    const result = execSync(ctx.testCommand, {
      cwd: ctx.projectRoot,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = result.trim();
    return [{
      name: 'tests pass',
      passed: true,
      detail: output ? output.split('\n')[0] ?? 'all tests passed' : 'all tests passed',
    }];
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    const combined = [err.stderr?.trim(), err.stdout?.trim()].filter(Boolean).join('\n');
    const currentFailures = parseFailingTests(combined);

    const newFailures = new Set([...currentFailures].filter(f => !baselineFailures.has(f)));

    if (newFailures.size === 0 && currentFailures.size > 0) {
      // Only pre-existing failures — this is fine
      return [{
        name: 'tests pass',
        passed: true,
        detail: `${currentFailures.size} existing failure(s) — no new failures introduced`,
      }];
    }

    if (newFailures.size > 0) {
      const names = [...newFailures].slice(0, 5).join(', ');
      return [{
        name: 'tests pass',
        passed: false,
        detail: `${newFailures.size} new test failure(s): ${names}`,
      }];
    }

    // Couldn't parse failures or all tests passed? Fall back to raw output
    const detail = combined || `test command failed: ${err.message}`;
    return [{
      name: 'tests pass',
      passed: false,
      detail,
    }];
  }
}

/**
 * Run the test command and extract the set of currently failing test names.
 * Used to establish a baseline before a task runs so that pre-existing
 * failures don't block verification.
 */
export function collectFailingTests(testCommand: string, projectRoot: string): Set<string> {
  try {
    execSync(testCommand, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new Set();
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    const combined = [err.stderr?.trim(), err.stdout?.trim()].filter(Boolean).join('\n');
    return parseFailingTests(combined);
  }
}

function parseFailingTests(output: string): Set<string> {
  const names = new Set<string>();

  // Jest / Vitest: FAIL path/to/file.test.ts
  //                  ✕ test description
  for (const line of output.split('\n')) {
    const failMatch = line.match(/^\s*FAIL\s+(.+)$/);
    if (failMatch) {
      names.add(failMatch[1].trim());
      continue;
    }

    // pytest: FAILED path/to/file.py::TestClass::test_name
    const pytestMatch = line.match(/FAILED\s+(.+?)(?:\s+\[.*\])?$/);
    if (pytestMatch) {
      names.add(pytestMatch[1].trim());
      continue;
    }

    // go test: --- FAIL: TestName (0.00s)
    const goMatch = line.match(/--- FAIL:\s+(\S+)/);
    if (goMatch) {
      names.add(goMatch[1].trim());
      continue;
    }

    // Vitest inline: × test description  (left of timestamps)
    const vitestMatch = line.match(/^\s*[×✕]\s+(.+?)(?:\s+\d+ms)?$/);
    if (vitestMatch && vitestMatch[1].length > 2) {
      names.add(vitestMatch[1].trim());
      continue;
    }
  }

  return names;
}

function verifyShellTests(
  ctx: CheckContext,
  calls: Array<{ name: string; input: Record<string, unknown> }>,
): Check[] {
  const checks: Check[] = [];
  const testPatterns = ['npm test', 'pytest', 'jest', 'vitest', 'go test', 'cargo test', 'npx vitest run'];

  for (const call of calls) {
    const cmd = String(call.input.command ?? '');
    const isTest = testPatterns.some(p => cmd.includes(p));
    if (!isTest) continue;

    try {
      execSync(cmd, {
        cwd: ctx.projectRoot,
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      checks.push({ name: 'shell test', passed: true, detail: `"${cmd}" — passed` });
    } catch {
      checks.push({ name: 'shell test', passed: false, detail: `"${cmd}" — failed` });
    }
  }
  return checks;
}

function verifyTaskIntent(ctx: CheckContext): Check[] {
  const lower = ctx.task.toLowerCase();
  const createWords = ['create', 'write', 'add', 'make', 'generate', 'scaffold'];
  const hasCreateIntent = createWords.some(w => lower.includes(w));
  if (!hasCreateIntent) return [];

  const fileWrites = ctx.toolCalls.filter(c => c.name === 'write_file');
  if (fileWrites.length > 0) return [];

  const nowFiles = collectProjectFiles(ctx.projectRoot);
  const newFiles = [...nowFiles].filter(f => !ctx.filesBefore.has(f));

  if (newFiles.length > 0) {
    return [{
      name: 'files created',
      passed: true,
      detail: `${newFiles.length} new file(s): ${newFiles.slice(0, 3).join(', ')}`,
    }];
  }

  return [{
    name: 'files created',
    passed: false,
    detail: `task intent was "${ctx.task.slice(0, 50)}" but no files were created`,
  }];
}

export function collectProjectFiles(root: string): Set<string> {
  const files = new Set<string>();
  const ignore = ['node_modules', '.git', 'dist', 'build', '__pycache__', 'coverage', '.next'];
  function walk(dir: string, depth: number) {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (ignore.includes(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) { walk(full, depth + 1); } else { files.add(rel); }
    }
  }
  walk(root, 0);
  return files;
}
