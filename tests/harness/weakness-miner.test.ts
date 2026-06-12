import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  mineWeaknesses,
  saveReport,
  loadReport,
  reportPath,
  type WeaknessReport,
} from '../../src/harness/weakness-miner.js';
import type { HistoryMessage } from '../../src/providers/types.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'weakness-miner-test-'));
}

function writeSession(dir: string, id: string, history: HistoryMessage[]): void {
  const session = {
    id,
    title: `Test session ${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    history,
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(session, null, 2));
}

describe('weakness-miner', () => {
  let tmpDir: string;
  let outPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    outPath = path.join(tmpDir, 'report.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty patterns when no sessions exist', () => {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir);
    const report = mineWeaknesses(emptyDir);
    expect(report.sessionsAnalyzed).toBe(0);
    expect(report.patterns).toHaveLength(0);
    expect(report.summary).toContain('No recurring');
  });

  it('detects no-tool-calls pattern with 2+ occurrences', () => {
    const sesDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sesDir);

    // Session with prose-only response, no tool calls
    const history1: HistoryMessage[] = [
      { role: 'user', content: 'Fix the bug in auth' },
      { role: 'assistant', content: 'I looked at the code and it seems fine. The issue might be elsewhere in the system.' },
    ];
    const history2: HistoryMessage[] = [
      { role: 'user', content: 'Add unit tests for utils' },
      { role: 'assistant', content: 'The code is already well tested and does not need additional tests at this time.' },
    ];

    writeSession(sesDir, 'ses1', history1);
    writeSession(sesDir, 'ses2', history2);

    const report = mineWeaknesses(sesDir);
    const pattern = report.patterns.find(p => p.pattern === 'no-tool-calls');
    expect(pattern).toBeDefined();
    expect(pattern!.frequency).toBe(2);
    expect(pattern!.occurrences[0].exampleTask).toContain('Fix the bug');
    expect(pattern!.promptPatch).toContain('PATCH');
  });

  it('detects explored-not-executed pattern', () => {
    const sesDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sesDir);

    // Session 1: only read_file calls
    const history1: HistoryMessage[] = [
      { role: 'user', content: 'Refactor the database module' },
      { role: 'assistant', content: 'Let me look at the code.', toolCalls: [
        { id: 'tc1', name: 'read_file', input: { path: 'src/db.ts' } },
        { id: 'tc2', name: 'read_file', input: { path: 'src/models.ts' } },
        { id: 'tc3', name: 'search_code', input: { pattern: 'database', literal: false, case_sensitive: false, max_results: 10 } },
      ]},
      { role: 'tool_result', results: [
        { id: 'tc1', name: 'read_file', content: 'file content here' },
        { id: 'tc2', name: 'read_file', content: 'file content here' },
        { id: 'tc3', name: 'search_code', content: 'Found 3 results' },
      ]},
      { role: 'assistant', content: 'I see the structure. The code is well organized already.' },
    ];

    // Session 2: only read_file calls
    const history2: HistoryMessage[] = [
      { role: 'user', content: 'Add error handling to API' },
      { role: 'assistant', content: 'Let me check the API code.', toolCalls: [
        { id: 'tc4', name: 'read_file', input: { path: 'src/api.ts' } },
        { id: 'tc5', name: 'list_dir', input: { path: 'src/', recursive: false, depth: 2 } },
      ]},
      { role: 'tool_result', results: [
        { id: 'tc4', name: 'read_file', content: 'file content here' },
        { id: 'tc5', name: 'list_dir', content: 'src/api.ts\nsrc/types.ts' },
      ]},
      { role: 'assistant', content: 'The code looks fine as is.' },
    ];

    writeSession(sesDir, 'ses1', history1);
    writeSession(sesDir, 'ses2', history2);

    const report = mineWeaknesses(sesDir);
    const pattern = report.patterns.find(p => p.pattern === 'explored-not-executed');
    expect(pattern).toBeDefined();
    expect(pattern!.frequency).toBe(2);
    expect(pattern!.occurrences[0].exampleFailure).toContain('read-only calls');
  });

  it('detects test-regression pattern', () => {
    const sesDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sesDir);

    const history1: HistoryMessage[] = [
      { role: 'user', content: 'Add feature X' },
      { role: 'assistant', content: 'Implementing now.', toolCalls: [
        { id: 'tc1', name: 'write_file', input: { path: 'src/feature.ts', content: 'export const x = 1;' } },
        { id: 'tc2', name: 'run_tests', input: {} },
      ]},
      { role: 'tool_result', results: [
        { id: 'tc1', name: 'write_file', content: '✓ Created src/feature.ts (1 lines)' },
        { id: 'tc2', name: 'run_tests', content: 'FAIL tests/feature.test.ts\n2 tests failed, 1 passed', isError: true },
      ]},
      { role: 'assistant', content: 'Tests failed. I need to fix them.' },
    ];

    const history2: HistoryMessage[] = [
      { role: 'user', content: 'Refactor utils' },
      { role: 'assistant', content: 'Refactoring.', toolCalls: [
        { id: 'tc3', name: 'edit_file', input: { path: 'src/utils.ts' } },
        { id: 'tc4', name: 'run_tests', input: {} },
      ]},
      { role: 'tool_result', results: [
        { id: 'tc3', name: 'edit_file', content: '✓ Edited src/utils.ts' },
        { id: 'tc4', name: 'run_tests', content: 'FAIL tests/utils.test.ts\n3 tests failing', isError: true },
      ]},
      { role: 'assistant', content: 'We have some failing tests to fix.' },
    ];

    writeSession(sesDir, 'ses1', history1);
    writeSession(sesDir, 'ses2', history2);

    const report = mineWeaknesses(sesDir);
    const pattern = report.patterns.find(p => p.pattern === 'test-regression');
    expect(pattern).toBeDefined();
    expect(pattern!.frequency).toBe(2);
    expect(pattern!.occurrences[0].exampleFailure).toContain('FAIL');
  });

  it('detects loop-exhausted pattern', () => {
    const sesDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sesDir);

    const history1: HistoryMessage[] = [
      { role: 'user', content: 'Complex refactoring task' },
      { role: 'assistant', content: 'Working on it...', toolCalls: [
        { id: 'tc1', name: 'read_file', input: { path: 'src/main.ts' } },
      ]},
      { role: 'tool_result', results: [
        { id: 'tc1', name: 'read_file', content: 'content' },
      ]},
      { role: 'assistant', content: 'Loop ended after 150 turns. Type /continue to resume session ses1' },
    ];

    const history2: HistoryMessage[] = [
      { role: 'user', content: 'Fix all bugs' },
      { role: 'assistant', content: 'Trying...', toolCalls: [
        { id: 'tc2', name: 'search_code', input: { pattern: 'bug', literal: false, case_sensitive: false, max_results: 10 } },
      ]},
      { role: 'tool_result', results: [
        { id: 'tc2', name: 'search_code', content: 'Found 5 results' },
      ]},
      { role: 'assistant', content: 'Loop ended after 150 turns.' },
    ];

    writeSession(sesDir, 'ses1', history1);
    writeSession(sesDir, 'ses2', history2);

    const report = mineWeaknesses(sesDir);
    const pattern = report.patterns.find(p => p.pattern === 'loop-exhausted');
    expect(pattern).toBeDefined();
    expect(pattern!.frequency).toBe(2);
    expect(pattern!.promptPatch).toContain('Work efficiently');
  });

  it('detects safety-false-positive pattern', () => {
    const sesDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sesDir);

    const history1: HistoryMessage[] = [
      { role: 'user', content: 'Create directory structure' },
      { role: 'assistant', content: 'Creating dirs.', toolCalls: [
        { id: 'tc1', name: 'run_shell', input: { command: 'mkdir -p src/new-module' } },
      ]},
      { role: 'tool_result', results: [
        { id: 'tc1', name: 'run_shell', content: "Blocked: Dangerous command blocked: mkdir -p src/new-module", isError: true },
      ]},
      { role: 'assistant', content: 'The command was blocked.' },
    ];

    const history2: HistoryMessage[] = [
      { role: 'user', content: 'List files' },
      { role: 'assistant', content: 'Listing.', toolCalls: [
        { id: 'tc2', name: 'run_shell', input: { command: 'ls -la src/' } },
      ]},
      { role: 'tool_result', results: [
        { id: 'tc2', name: 'run_shell', content: 'Blocked: Dangerous command blocked: ls -la src/', isError: true },
      ]},
      { role: 'assistant', content: 'The command was blocked.' },
    ];

    writeSession(sesDir, 'ses1', history1);
    writeSession(sesDir, 'ses2', history2);

    const report = mineWeaknesses(sesDir);
    const pattern = report.patterns.find(p => p.pattern === 'safety-false-positive');
    expect(pattern).toBeDefined();
    expect(pattern!.frequency).toBe(2);
    expect(pattern!.promptPatch).toContain('SAFE_SHELL_COMMANDS');
  });

  it('detects file-not-created pattern', () => {
    const sesDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sesDir);

    const history1: HistoryMessage[] = [
      { role: 'user', content: 'Create config file' },
      { role: 'assistant', content: 'Writing config.', toolCalls: [
        { id: 'tc1', name: 'write_file', input: { path: '/readonly/config.json', content: '{}' } },
      ]},
      { role: 'tool_result', results: [
        { id: 'tc1', name: 'write_file', content: 'Error: EACCES: permission denied', isError: true },
      ]},
      { role: 'assistant', content: 'Permission denied.' },
    ];

    const history2: HistoryMessage[] = [
      { role: 'user', content: 'Create module file' },
      { role: 'assistant', content: 'Writing module.', toolCalls: [
        { id: 'tc2', name: 'write_file', input: { path: '/tmp/missing/module.ts', content: 'export {}' } },
      ]},
      { role: 'tool_result', results: [
        { id: 'tc2', name: 'write_file', content: 'Error: ENOENT: no such file or directory', isError: true },
      ]},
      { role: 'assistant', content: 'Missing directory.' },
    ];

    writeSession(sesDir, 'ses1', history1);
    writeSession(sesDir, 'ses2', history2);

    const report = mineWeaknesses(sesDir);
    const pattern = report.patterns.find(p => p.pattern === 'file-not-created');
    expect(pattern).toBeDefined();
    expect(pattern!.frequency).toBe(2);
  });

  it('does not include patterns with fewer than 2 occurrences', () => {
    const sesDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sesDir);

    // Only one no-tool-calls session
    const history: HistoryMessage[] = [
      { role: 'user', content: 'Explain the code' },
      { role: 'assistant', content: 'The code is a TypeScript project with various modules.' },
    ];

    writeSession(sesDir, 'ses1', history);

    const report = mineWeaknesses(sesDir);
    expect(report.patterns).toHaveLength(0);
  });

  it('sorts patterns by frequency descending', () => {
    const sesDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sesDir);

    // 3 no-tool-calls
    for (let i = 0; i < 3; i++) {
      writeSession(sesDir, `notc-${i}`, [
        { role: 'user', content: `Task ${i}` },
        { role: 'assistant', content: `I analyzed the code carefully and it all looks correct to me for task ${i}.` },
      ]);
    }

    // 2 explored-not-executed
    for (let i = 0; i < 2; i++) {
      writeSession(sesDir, `explore-${i}`, [
        { role: 'user', content: `Explore task ${i}` },
        { role: 'assistant', content: 'Reading files.', toolCalls: [
          { id: `tc-${i}`, name: 'read_file', input: { path: 'src/main.ts' } },
        ]},
        { role: 'tool_result', results: [
          { id: `tc-${i}`, name: 'read_file', content: 'content' },
        ]},
        { role: 'assistant', content: 'The code is fine.' },
      ]);
    }

    const report = mineWeaknesses(sesDir);
    expect(report.patterns.length).toBeGreaterThanOrEqual(2);
    expect(report.patterns[0].frequency).toBeGreaterThanOrEqual(report.patterns[1].frequency);
  });

  it('saves and loads report', () => {
    const report: WeaknessReport = {
      generatedAt: new Date().toISOString(),
      sessionsAnalyzed: 5,
      patterns: [],
      summary: 'All good.',
    };

    saveReport(report, outPath);
    expect(fs.existsSync(outPath)).toBe(true);

    const loaded = loadReport(outPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionsAnalyzed).toBe(5);
    expect(loaded!.summary).toBe('All good.');
  });

  it('returns null for non-existent report path', () => {
    const loaded = loadReport(path.join(tmpDir, 'nonexistent.json'));
    expect(loaded).toBeNull();
  });

  it('handles project subdirectory structure', () => {
    const sesDir = path.join(tmpDir, 'sessions');
    const projDir = path.join(sesDir, 'my_project');
    fs.mkdirSync(projDir, { recursive: true });

    writeSession(projDir, 'ses1', [
      { role: 'user', content: 'Task A' },
      { role: 'assistant', content: 'I have carefully analyzed the requirements and they look good.' },
    ]);
    writeSession(projDir, 'ses2', [
      { role: 'user', content: 'Task B' },
      { role: 'assistant', content: 'Based on my analysis, no changes are needed for this task.' },
    ]);

    const report = mineWeaknesses(sesDir);
    const pattern = report.patterns.find(p => p.pattern === 'no-tool-calls');
    expect(pattern).toBeDefined();
    expect(pattern!.frequency).toBe(2);
    expect(report.sessionsAnalyzed).toBe(2);
  });

  it('reportPath returns a valid path', () => {
    const p = reportPath();
    expect(p).toContain('.rubycode');
    expect(p).toContain('weakness-report.json');
  });
});
