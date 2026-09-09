import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { readFile } from '../src/tools/read-file.js';
import { editFile } from '../src/tools/edit-file.js';
import { writeFile } from '../src/tools/tools.js';
import { runShell } from '../src/tools/tools.js';
import { searchCode } from '../src/tools/tools.js';
import { gitDiff } from '../src/tools/tools.js';

describe('readFile', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-test-'));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('reads a small file with line numbers', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'one\ntwo\nthree');
    const out = await readFile({ path: 'a.txt' }, tmpDir);
    expect(out).toContain('1: one');
    expect(out).toContain('2: two');
    expect(out).toContain('3: three');
    expect(out).toContain('(3 lines)');
  });

  it('reads a range', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a\nb\nc\nd\ne');
    const out = await readFile({ path: 'a.txt', start_line: 2, end_line: 4 }, tmpDir);
    expect(out).toContain('2: b');
    expect(out).toContain('3: c');
    expect(out).toContain('4: d');
    expect(out).not.toContain('1: a');
  });

  it('errors on missing file', async () => {
    expect(await readFile({ path: 'nope.txt' }, tmpDir)).toMatch(/Error: File not found/);
  });

  it('truncates huge files with head + tail', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'big.txt'), lines);
    const out = await readFile({ path: 'big.txt' }, tmpDir);
    expect(out).toContain('1: line 1');
    expect(out).toMatch(/lines omitted/);
    expect(out).toContain('1000: line 1000');
  });
});

describe('editFile', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-test-'));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('replaces exact match', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;\nconst y = 2;');
    const result = editFile({ path: 'a.ts', find: 'const x = 1;', replace: 'const x = 99;' }, tmpDir);
    expect(result).toContain('Edit applied');
    expect(fs.readFileSync(path.join(tmpDir, 'a.ts'), 'utf8')).toBe('const x = 99;\nconst y = 2;');
  });

  it('returns helpful error on missing block', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'hello world');
    const result = editFile({ path: 'a.ts', find: 'goodbye', replace: 'hi' }, tmpDir);
    expect(result).toMatch(/Could not find/);
  });

  it('handles CRLF line endings', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'line1\r\nline2\r\nline3');
    const result = editFile({ path: 'a.txt', find: 'line2', replace: 'LINE_TWO' }, tmpDir);
    expect(result).toContain('Edit applied');
  });
});

describe('writeFile', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-test-'));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('creates new file', () => {
    const result = writeFile({ path: 'new.txt', content: 'hi' }, tmpDir);
    expect(result).toContain('Created');
    expect(fs.readFileSync(path.join(tmpDir, 'new.txt'), 'utf8')).toBe('hi');
  });

  it('overwrites existing file', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'old');
    const result = writeFile({ path: 'a.txt', content: 'new' }, tmpDir);
    expect(result).toContain('Overwrote');
  });

  it('creates parent directories', () => {
    writeFile({ path: 'deep/nested/dir/a.txt', content: 'x' }, tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'deep/nested/dir/a.txt'))).toBe(true);
  });
});

describe('runShell', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-test-'));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('runs echo', () => {
    const out = runShell({ command: 'echo hello' }, tmpDir);
    expect(out).toBe('hello');
  });

  it('respects cwd override', () => {
    fs.writeFileSync(path.join(tmpDir, 'marker.txt'), 'present');
    const out = runShell({ command: 'ls marker.txt' }, tmpDir);
    expect(out).toContain('marker.txt');
  });

  it('times out gracefully', () => {
    const out = runShell({ command: 'sleep 5', timeout: 100 }, tmpDir);
    expect(out).toMatch(/timed out/i);
  });
});

describe('searchCode', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-test-'));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('finds matches across files', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'const y = 2;');
    const out = searchCode({ pattern: 'const', literal: true, case_sensitive: true, max_results: 10 }, tmpDir);
    expect(out).toContain('2 results');
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
  });

  it('reports no results', () => {
    const out = searchCode({ pattern: 'doesnotexist_anywhere_xyz123', literal: true, case_sensitive: true, max_results: 10 }, tmpDir);
    expect(out).toMatch(/No results/);
  });

  it('caps total output chars so 50 long matches cannot flood context', () => {
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(tmpDir, `f${i}.ts`), `needle${i} ` + 'x'.repeat(900));
    }
    const out = searchCode({ pattern: 'needle', literal: true, case_sensitive: true, max_results: 30 }, tmpDir);
    expect(out).toMatch(/Found 30 results/);
    expect(out).toMatch(/cut at the 12K-char cap/);
    // ripgrep walks the directory in parallel, so *which* files survive is not
    // deterministic — the invariant is the size, not the names. 30 matches at
    // ~900 chars each would be ~27K uncapped; the cap keeps it near 12K.
    const shown = out.split('\n\n')[1] ?? '';
    expect(shown.length).toBeLessThan(13_000);
    expect(shown.split('\n').length).toBeLessThan(30);
  });
});

describe('gitDiff', () => {
  let tmpDir: string;
  beforeEach(() => {
    // Raw git output: rtk (when installed) filters/compresses diff text, which
    // would defeat byte-level assertions about the truncation window.
    process.env.AURA_RTK = '0';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-git-'));
    execSync('git init -q', { cwd: tmpDir });
    execSync('git config user.email test@example.com', { cwd: tmpDir });
    execSync('git config user.name test', { cwd: tmpDir });
  });
  afterEach(() => {
    delete process.env.AURA_RTK;
    fs.rmSync(tmpDir, { recursive: true });
  });

  function commitAll(msg: string): void {
    execSync('git add -A', { cwd: tmpDir });
    execSync(`git commit -qm ${JSON.stringify(msg)}`, { cwd: tmpDir });
  }

  it('returns the diff and a clean-tree message', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'one');
    commitAll('init');
    expect(gitDiff({ path: '', staged: false }, tmpDir)).toMatch(/No changes/);

    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'two');
    const out = gitDiff({ path: '', staged: false }, tmpDir);
    expect(out).toContain('-one');
    expect(out).toContain('+two');
  });

  it('caps a whole-tree diff with a head + tail window instead of a head-only cut', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'A');
    commitAll('init');
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'B' + 'y'.repeat(29_000));
    const out = gitDiff({ path: '', staged: false }, tmpDir);
    expect(out).toMatch(/chars omitted — diff a file or directory in smaller pieces/);
    // Both ends survive: the +B at the start of the hunk and the real diff tail
    // (git marks the missing trailing newline AFTER the content line, so the
    // marker's presence proves the bottom of the file made it into the window).
    expect(out).toContain('+B');
    expect(out).toContain('\\ No newline at end of file');
    expect(out.length).toBeGreaterThan(20_000);
    expect(out.length).toBeLessThan(21_000);
    expect(out.slice(-8_000)).toContain('y'.repeat(1_000));
  });
});
