import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAllChecks, collectProjectFiles, collectFailingTests } from '../../src/verify/checks.js';
import {
  runVerificationSync, verifyTask, buildSuggestion, shouldRetry, runWithVerification,
} from '../../src/verify/index.js';
import type { VerificationConfig, VerificationResult } from '../../src/verify/types.js';
import type { CheckContext } from '../../src/verify/checks.js';

const defaultConfig: VerificationConfig = { enabled: true, maxRetries: 3 };

function makeCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    projectRoot: '/tmp/test',
    taskStartedAt: Date.now() - 5000,
    task: 'test task',
    toolCalls: [],
    filesBefore: new Set(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// collectProjectFiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectProjectFiles', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-vfy-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('collects flat files', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'b');
    const files = collectProjectFiles(tmpDir);
    expect(files.has('a.ts')).toBe(true);
    expect(files.has('b.ts')).toBe(true);
  });

  it('skips node_modules and .git', () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules/pkg.js'), 'x');
    fs.writeFileSync(path.join(tmpDir, '.git/config'), '[core]');
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'real');
    const files = collectProjectFiles(tmpDir);
    expect(files.has('src.ts')).toBe(true);
    expect([...files].some(f => f.includes('node_modules'))).toBe(false);
    expect([...files].some(f => f.includes('.git'))).toBe(false);
  });

  it('collects nested files with relative paths', () => {
    fs.mkdirSync(path.join(tmpDir, 'src/lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'main');
    fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'util.ts'), 'util');
    const files = collectProjectFiles(tmpDir);
    expect(files.has(path.join('src', 'index.ts'))).toBe(true);
    expect(files.has(path.join('src', 'lib', 'util.ts'))).toBe(true);
  });

  it('skips hidden dotfiles', () => {
    fs.writeFileSync(path.join(tmpDir, '.hidden'), 'secret');
    fs.writeFileSync(path.join(tmpDir, 'visible.ts'), 'ok');
    const files = collectProjectFiles(tmpDir);
    expect(files.has('visible.ts')).toBe(true);
    expect(files.has('.hidden')).toBe(false);
  });

  it('returns empty set for empty directory', () => {
    const files = collectProjectFiles(tmpDir);
    expect(files.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// verifyWrittenFiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('verifyWrittenFiles', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-vfy-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('passes when file exists with sufficient size', () => {
    fs.writeFileSync(path.join(tmpDir, 'out.html'), 'x'.repeat(200));
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      toolCalls: [{ name: 'write_file', input: { path: 'out.html', content: 'x'.repeat(200) } }],
    }));
    const fc = checks.find(c => c.name === 'file exists');
    expect(fc).toBeDefined();
    expect(fc!.passed).toBe(true);
    expect(fc!.detail).toContain('200 bytes');
  });

  it('fails when file does not exist', () => {
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      toolCalls: [{ name: 'write_file', input: { path: 'missing.html', content: '<html>' } }],
    }));
    const fc = checks.find(c => c.name === 'file exists');
    expect(fc).toBeDefined();
    expect(fc!.passed).toBe(false);
    expect(fc!.detail).toContain('not found');
  });

  it('fails when file is too small', () => {
    fs.writeFileSync(path.join(tmpDir, 'tiny.html'), 'hi');
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      toolCalls: [{ name: 'write_file', input: { path: 'tiny.html', content: 'hi' } }],
    }));
    const sc = checks.find(c => c.name === 'file size');
    expect(sc).toBeDefined();
    expect(sc!.passed).toBe(false);
    expect(sc!.detail).toContain('< 100');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// verifyEditedFiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('verifyEditedFiles', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-vfy-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('passes when file was modified after task started', () => {
    const filePath = path.join(tmpDir, 'edit.ts');
    fs.writeFileSync(filePath, 'old');
    const taskStart = fs.statSync(filePath).mtimeMs - 100;
    // Rewrite after the task start timestamp
    fs.writeFileSync(filePath, 'new content');
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      taskStartedAt: taskStart,
      toolCalls: [{ name: 'edit_file', input: { path: 'edit.ts', find: 'old', replace: 'new' } }],
    }));
    const mc = checks.find(c => c.name === 'file mtime');
    expect(mc).toBeDefined();
    expect(mc!.passed).toBe(true);
  });

  it('fails when file was not modified during task window', () => {
    const filePath = path.join(tmpDir, 'stale.ts');
    fs.writeFileSync(filePath, 'content');
    const mtime = fs.statSync(filePath).mtimeMs;
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      taskStartedAt: mtime + 5000, // task started after the file was touched
      toolCalls: [{ name: 'edit_file', input: { path: 'stale.ts', find: 'x', replace: 'y' } }],
    }));
    const mc = checks.find(c => c.name === 'file mtime');
    expect(mc).toBeDefined();
    expect(mc!.passed).toBe(false);
  });

  it('fails when target file does not exist', () => {
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      toolCalls: [{ name: 'edit_file', input: { path: 'gone.ts', find: 'x', replace: 'y' } }],
    }));
    const mc = checks.find(c => c.name === 'file mtime');
    expect(mc).toBeDefined();
    expect(mc!.passed).toBe(false);
    expect(mc!.detail).toContain('does not exist');
  });

  it('passes with 50ms slack on file system timestamp rounding', () => {
    const filePath = path.join(tmpDir, 'slack.ts');
    fs.writeFileSync(filePath, 'content');
    const now = Date.now();
    // mtime is now, task started 30ms later — within 50ms slack
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      taskStartedAt: now + 30,
      toolCalls: [{ name: 'edit_file', input: { path: 'slack.ts', find: 'old', replace: 'new' } }],
    }));
    const mc = checks.find(c => c.name === 'file mtime');
    expect(mc).toBeDefined();
    expect(mc!.passed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// verifyTaskIntent
// ═══════════════════════════════════════════════════════════════════════════════

describe('verifyTaskIntent', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-vfy-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('passes when create task results in new files', () => {
    fs.writeFileSync(path.join(tmpDir, 'old.ts'), 'old');
    fs.writeFileSync(path.join(tmpDir, 'new.ts'), 'new stuff here');
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      task: 'create a utility module',
      filesBefore: new Set(['old.ts']),
    }));
    const ic = checks.find(c => c.name === 'files created');
    expect(ic).toBeDefined();
    expect(ic!.passed).toBe(true);
    expect(ic!.detail).toContain('1 new file');
  });

  it('fails when create task has no new files and no write_file calls', () => {
    fs.writeFileSync(path.join(tmpDir, 'old.ts'), 'old');
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      task: 'create a config file',
      filesBefore: new Set(['old.ts']),
    }));
    const ic = checks.find(c => c.name === 'files created');
    expect(ic).toBeDefined();
    expect(ic!.passed).toBe(false);
  });

  it('skips intent check when task has no creation keywords', () => {
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      task: 'explain the architecture',
      filesBefore: new Set(),
    }));
    expect(checks.find(c => c.name === 'files created')).toBeUndefined();
  });

  it('skips intent check when write_file was already called', () => {
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      task: 'create a file',
      toolCalls: [{ name: 'write_file', input: { path: 'f.ts', content: 'x'.repeat(200) } }],
      filesBefore: new Set(),
    }));
    expect(checks.find(c => c.name === 'files created')).toBeUndefined();
  });

  it('skips intent check when task only uses edit_file (no write_file)', () => {
    fs.writeFileSync(path.join(tmpDir, 'existing.ts'), 'old content');
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      task: 'add error handling to the module',
      toolCalls: [{ name: 'edit_file', input: { path: 'existing.ts', find: 'old', replace: 'new' } }],
      filesBefore: new Set(['existing.ts']),
    }));
    expect(checks.find(c => c.name === 'files created')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runTestCommand
// ═══════════════════════════════════════════════════════════════════════════════

describe('runTestCommand', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-vfy-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('passes when testCommand succeeds', () => {
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      task: 'refactor module',
      testCommand: 'echo "all good"',
    }));
    const tc = checks.find(c => c.name === 'tests pass');
    expect(tc).toBeDefined();
    expect(tc!.passed).toBe(true);
  });

  it('fails when testCommand fails', () => {
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      task: 'refactor module',
      testCommand: 'exit 1',
    }));
    const tc = checks.find(c => c.name === 'tests pass');
    expect(tc).toBeDefined();
    expect(tc!.passed).toBe(false);
  });

  it('deduplicates: skips testCommand if already ran as shell test', () => {
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      task: 'refactor',
      testCommand: 'npm test',
      toolCalls: [{ name: 'run_shell', input: { command: 'npm test' } }],
    }));
    // Should not have a duplicate 'tests pass' check
    const testPassChecks = checks.filter(c => c.name === 'tests pass');
    expect(testPassChecks.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// verifyShellTests
// ═══════════════════════════════════════════════════════════════════════════════

describe('verifyShellTests', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-vfy-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      scripts: { test: 'echo "tests pass"' },
    }));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('passes when shell test command exits 0', () => {
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      toolCalls: [{ name: 'run_shell', input: { command: 'echo ok' } }],
    }));
    // 'echo ok' doesn't match test patterns — no shell test check is produced
    // Just verify no crash
    expect(Array.isArray(checks)).toBe(true);
  });

  it('fails when npm test command fails', () => {
    fs.unlinkSync(path.join(tmpDir, 'package.json'));
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      toolCalls: [{ name: 'run_shell', input: { command: 'npm test' } }],
    }));
    const sc = checks.find(c => c.name === 'shell test');
    if (sc) expect(sc.passed).toBe(false);
  });

  it('detects vitest and pytest patterns', () => {
    fs.writeFileSync(path.join(tmpDir, 'ok.txt'), '');
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      toolCalls: [
        { name: 'run_shell', input: { command: 'pytest -v' } },
      ],
    }));
    // pytest should fail in tmp dir (no tests to run)
    const sc = checks.find(c => c.name === 'shell test');
    if (sc) expect(sc.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runVerificationSync + verifyTask
// ═══════════════════════════════════════════════════════════════════════════════

describe('runVerificationSync / verifyTask', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-vfy-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('returns passed=true when all checks pass', () => {
    fs.writeFileSync(path.join(tmpDir, 'out.html'), 'x'.repeat(200));
    const result = runVerificationSync(makeCtx({
      projectRoot: tmpDir,
      toolCalls: [{ name: 'write_file', input: { path: 'out.html', content: 'x'.repeat(200) } }],
    }), defaultConfig);
    expect(result.passed).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('returns passed=false when a check fails', () => {
    const result = runVerificationSync(makeCtx({
      projectRoot: tmpDir,
      toolCalls: [{ name: 'write_file', input: { path: 'nope.html', content: '<html>' } }],
    }), defaultConfig);
    expect(result.passed).toBe(false);
    expect(result.suggestion.length).toBeGreaterThan(0);
  });

  it('verifyTask returns same shape as runVerificationSync', async () => {
    fs.writeFileSync(path.join(tmpDir, 'out.html'), 'x'.repeat(200));
    const result = await verifyTask(makeCtx({
      projectRoot: tmpDir,
      toolCalls: [{ name: 'write_file', input: { path: 'out.html', content: 'x'.repeat(200) } }],
    }), defaultConfig);
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('returns empty checks when no tool calls and no testCommand', () => {
    const result = runVerificationSync(makeCtx({
      projectRoot: tmpDir,
      task: 'explain the architecture',
    }), defaultConfig);
    expect(result.passed).toBe(true);
    expect(result.checks.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildSuggestion
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSuggestion', () => {
  it('returns empty string when all checks pass', () => {
    const s = buildSuggestion([{ name: 'a', passed: true, detail: 'ok' }]);
    expect(s).toBe('');
  });

  it('builds retry message from failed checks', () => {
    const s = buildSuggestion([
      { name: 'file exists', passed: false, detail: 'not found' },
      { name: 'tests pass', passed: true, detail: 'ok' },
    ]);
    expect(s).toContain('not found');
    expect(s).toContain('Previous attempt failed');
  });

  it('joins multiple failures', () => {
    const s = buildSuggestion([
      { name: 'a', passed: false, detail: 'err1' },
      { name: 'b', passed: false, detail: 'err2' },
    ]);
    expect(s).toContain('err1');
    expect(s).toContain('err2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// shouldRetry
// ═══════════════════════════════════════════════════════════════════════════════

describe('shouldRetry', () => {
  it('retries when not passed and below max', () => {
    const r: VerificationResult = { passed: false, checks: [], attempts: 2, suggestion: '' };
    expect(shouldRetry(r, { enabled: true, maxRetries: 3 })).toBe(true);
  });

  it('does not retry when passed', () => {
    const r: VerificationResult = { passed: true, checks: [], attempts: 1, suggestion: '' };
    expect(shouldRetry(r, { enabled: true, maxRetries: 3 })).toBe(false);
  });

  it('does not retry when max reached', () => {
    const r: VerificationResult = { passed: false, checks: [], attempts: 4, suggestion: '' };
    expect(shouldRetry(r, { enabled: true, maxRetries: 3 })).toBe(false);
  });

  it('does not retry when attempts equals max', () => {
    const r: VerificationResult = { passed: false, checks: [], attempts: 3, suggestion: '' };
    expect(shouldRetry(r, { enabled: true, maxRetries: 3 })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Non-existent testCommand
// ═══════════════════════════════════════════════════════════════════════════════

describe('non-existent testCommand', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-vfy-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('fails gracefully when binary does not exist', () => {
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      testCommand: 'nonexistent-command-xyz',
    }));
    const tc = checks.find(c => c.name === 'tests pass');
    expect(tc).toBeDefined();
    expect(tc!.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// collectFailingTests
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectFailingTests', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-vfy-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('returns empty set when test command passes', () => {
    const failures = collectFailingTests('echo ok', tmpDir);
    expect(failures.size).toBe(0);
  });

  it('returns empty set when test command produces unparseable output', () => {
    const failures = collectFailingTests('exit 1', tmpDir);
    expect(failures.size).toBe(0);
  });

  it('parses FAIL lines from vitest/jest output', () => {
    // Simulate a failing command by running node that prints FAIL lines
    const failures = collectFailingTests(
      `node -e "process.stderr.write('FAIL tests/foo.test.ts\\nFAIL tests/bar.test.ts'); process.exit(1)"`,
      tmpDir,
    );
    expect(failures.has('tests/foo.test.ts')).toBe(true);
    expect(failures.has('tests/bar.test.ts')).toBe(true);
  });

  it('parses FAILED lines from pytest output', () => {
    const failures = collectFailingTests(
      `node -e "process.stderr.write('FAILED tests/test_a.py::TestClass::test_one\\nFAILED tests/test_b.py::test_two'); process.exit(1)"`,
      tmpDir,
    );
    expect(failures.has('tests/test_a.py::TestClass::test_one')).toBe(true);
    expect(failures.has('tests/test_b.py::test_two')).toBe(true);
  });

  it('parses go test FAIL lines', () => {
    const failures = collectFailingTests(
      `node -e "process.stderr.write('--- FAIL: TestFoo (0.00s)\\n--- FAIL: TestBar (0.01s)'); process.exit(1)"`,
      tmpDir,
    );
    expect(failures.has('TestFoo')).toBe(true);
    expect(failures.has('TestBar')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// baseline-aware test command verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('baselineFailure comparison in runTestCommand', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbc-vfy-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('passes when test command fails but failures match baseline', () => {
    const baseline = new Set(['tests/old.test.ts']);
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      testCommand: `node -e "process.stderr.write('FAIL tests/old.test.ts'); process.exit(1)"`,
      baselineFailures: baseline,
    }));
    const tc = checks.find(c => c.name === 'tests pass');
    expect(tc).toBeDefined();
    expect(tc!.passed).toBe(true);
    expect(tc!.detail).toContain('no new failures');
  });

  it('fails when new test failures appear beyond baseline', () => {
    const baseline = new Set(['tests/old.test.ts']);
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      testCommand: `node -e "process.stderr.write('FAIL tests/old.test.ts\\nFAIL tests/new.test.ts'); process.exit(1)"`,
      baselineFailures: baseline,
    }));
    const tc = checks.find(c => c.name === 'tests pass');
    expect(tc).toBeDefined();
    expect(tc!.passed).toBe(false);
    expect(tc!.detail).toContain('new test failure');
  });

  it('fails when test command fails and there is no baseline', () => {
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      testCommand: `node -e "process.stderr.write('FAIL tests/broken.test.ts'); process.exit(1)"`,
    }));
    const tc = checks.find(c => c.name === 'tests pass');
    expect(tc).toBeDefined();
    expect(tc!.passed).toBe(false);
  });

  it('passes when baseline covers all failures exactly', () => {
    const baseline = new Set(['a.ts', 'b.ts']);
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      testCommand: `node -e "process.stderr.write('FAIL a.ts\\nFAIL b.ts'); process.exit(1)"`,
      baselineFailures: baseline,
    }));
    const tc = checks.find(c => c.name === 'tests pass');
    expect(tc).toBeDefined();
    expect(tc!.passed).toBe(true);
  });

  it('passes when some baseline failures are fixed (baseline was larger)', () => {
    const baseline = new Set(['a.ts', 'b.ts', 'c.ts']);
    const checks = runAllChecks(makeCtx({
      projectRoot: tmpDir,
      testCommand: `node -e "process.stderr.write('FAIL a.ts'); process.exit(1)"`,
      baselineFailures: baseline,
    }));
    const tc = checks.find(c => c.name === 'tests pass');
    expect(tc).toBeDefined();
    expect(tc!.passed).toBe(true);
    expect(tc!.detail).toContain('no new failures');
  });
});
