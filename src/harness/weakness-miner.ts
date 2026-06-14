import * as fs from 'fs';
import * as path from 'path';
import type { HistoryMessage, ToolCall, ToolResult } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PatternName =
  | 'no-tool-calls'
  | 'file-not-created'
  | 'explored-not-executed'
  | 'test-regression'
  | 'loop-exhausted'
  | 'safety-false-positive';

export interface WeaknessOccurrence {
  sessionId: string;
  sessionTitle: string;
  /** The user task that triggered this pattern */
  exampleTask: string;
  /** Brief description of the failure */
  exampleFailure: string;
  timestamp: string;
}

export interface PatternReport {
  pattern: PatternName;
  frequency: number;
  description: string;
  occurrences: WeaknessOccurrence[];
  promptPatch: string;
}

export interface WeaknessReport {
  generatedAt: string;
  sessionsAnalyzed: number;
  patterns: PatternReport[];
  summary: string;
}

// Harmless commands that should not be blocked by the safety layer
const HARMLESS_COMMANDS = [
  'mkdir', 'ls', 'cat', 'echo', 'pwd', 'touch', 'cp', 'mv',
  'git status', 'git log', 'git diff', 'git show', 'git add', 'git commit',
  'npm test', 'npm run', 'npx', 'node', 'tsc',
  'which', 'find', 'grep', 'rg',
];

// ─────────────────────────────────────────────────────────────────────────────
// Session file reading
// ─────────────────────────────────────────────────────────────────────────────

export function sessionDir(): string {
  return process.env.AURA_SESSION_DIR ?? path.join(process.env.HOME ?? '/tmp', '.aura', 'sessions');
}

interface RawSession {
  id?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  savedAt?: string;
  version?: number;
  history: HistoryMessage[];
}

function loadAllSessions(baseDir: string): RawSession[] {
  const sessions: RawSession[] = [];
  if (!fs.existsSync(baseDir)) return sessions;

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      // Project subdirectory — scan for session files inside
      const subFiles = fs.readdirSync(fullPath).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
      for (const f of subFiles) {
        const session = parseSessionFile(path.join(fullPath, f));
        if (session) sessions.push(session);
      }
    } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.tmp')) {
      const session = parseSessionFile(fullPath);
      if (session) sessions.push(session);
    }
  }
  return sessions;
}

function parseSessionFile(filePath: string): RawSession | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RawSession>;
    if (!Array.isArray(parsed.history) || parsed.history.length === 0) return null;
    // Derive id from filename if missing
    if (!parsed.id) parsed.id = path.basename(filePath, '.json');
    return parsed as RawSession;
  } catch {
    return null;
  }
}

function getUserTask(history: HistoryMessage[]): string {
  const first = history.find(m => m.role === 'user');
  if (!first) return '(unknown task)';
  return typeof first.content === 'string' ? first.content.slice(0, 120) : '(unknown task)';
}

function getTimestamp(session: RawSession): string {
  return session.updatedAt ?? session.savedAt ?? session.createdAt ?? '(unknown time)';
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern detectors
// ─────────────────────────────────────────────────────────────────────────────

function collectToolCalls(history: HistoryMessage[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const msg of history) {
    if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
      calls.push(...msg.toolCalls);
    }
  }
  return calls;
}

function collectToolResults(history: HistoryMessage[]): ToolResult[] {
  const results: ToolResult[] = [];
  for (const msg of history) {
    if (msg.role === 'tool_result' && 'results' in msg) {
      results.push(...msg.results);
    }
  }
  return results;
}

function hasAssistantProse(history: HistoryMessage[]): boolean {
  return history.some(
    m => m.role === 'assistant' && 'content' in m && typeof m.content === 'string' && m.content.trim().length > 20,
  );
}

/** no-tool-calls: assistant responded with prose but zero tool invocations */
function detectNoToolCalls(session: RawSession): WeaknessOccurrence | null {
  const calls = collectToolCalls(session.history);
  if (calls.length > 0) return null;
  if (!hasAssistantProse(session.history)) return null;

  return {
    sessionId: session.id ?? '(unknown)',
    sessionTitle: session.title ?? '(untitled)',
    exampleTask: getUserTask(session.history),
    exampleFailure: 'Agent responded with prose only — no tool calls were made to investigate or solve the task.',
    timestamp: getTimestamp(session),
  };
}

/** file-not-created: write_file was called but the target file doesn't exist on disk */
function detectFileNotCreated(session: RawSession): WeaknessOccurrence[] {
  const calls = collectToolCalls(session.history);
  const results = collectToolResults(session.history);
  const occurrences: WeaknessOccurrence[] = [];

  for (const call of calls) {
    if (call.name !== 'write_file') continue;
    const filePath = String((call.input as Record<string, unknown>).path ?? '');
    if (!filePath) continue;

    // Check if the corresponding tool result indicates an error
    const matchingResult = results.find(r => r.id === call.id);
    if (matchingResult?.isError) {
      occurrences.push({
        sessionId: session.id ?? '(unknown)',
        sessionTitle: session.title ?? '(untitled)',
        exampleTask: getUserTask(session.history),
        exampleFailure: `write_file called for "${filePath}" but the operation reported an error: ${matchingResult.content.slice(0, 100)}`,
        timestamp: getTimestamp(session),
      });
    }
  }

  return occurrences;
}

/** explored-not-executed: only read operations (read_file, search_code, list_dir), no writes */
function detectExploredNotExecuted(session: RawSession): WeaknessOccurrence | null {
  const calls = collectToolCalls(session.history);
  if (calls.length === 0) return null;

  const readOnlyTools = ['read_file', 'search_code', 'list_dir', 'git_status', 'git_diff'];
  const writeTools = ['write_file', 'edit_file', 'run_shell', 'run_tests', 'spawn_task'];

  const hasOnlyReadOnly = calls.every(c => readOnlyTools.includes(c.name));
  const hasWriteAttempt = calls.some(c => writeTools.includes(c.name));

  if (!hasOnlyReadOnly || hasWriteAttempt) return null;

  return {
    sessionId: session.id ?? '(unknown)',
    sessionTitle: session.title ?? '(untitled)',
    exampleTask: getUserTask(session.history),
    exampleFailure: `Agent made ${calls.length} read-only calls (${Array.from(new Set(calls.map(c => c.name))).join(', ')}) but never attempted to write or execute anything.`,
    timestamp: getTimestamp(session),
  };
}

/** test-regression: run_tests was called and the result indicates new failures */
function detectTestRegression(session: RawSession): WeaknessOccurrence | null {
  const results = collectToolResults(session.history);
  const calls = collectToolCalls(session.history);

  // Only flag if run_tests was actually called
  const testCalls = calls.filter(c => c.name === 'run_tests');
  if (testCalls.length === 0) return null;

  // Look for test results with errors
  const testResults = results.filter(r => r.name === 'run_tests' || r.name === 'run_shell');
  const failedResult = testResults.find(r => {
    if (r.isError) return true;
    const content = r.content.toLowerCase();
    return content.includes('failed') || content.includes('failing') || content.includes('error') ||
           content.includes('FAIL ') || content.includes('✗') || content.includes('❌');
  });

  if (!failedResult) return null;

  return {
    sessionId: session.id ?? '(unknown)',
    sessionTitle: session.title ?? '(untitled)',
    exampleTask: getUserTask(session.history),
    exampleFailure: `Tests showed failures: ${failedResult.content.slice(0, 150)}`,
    timestamp: getTimestamp(session),
  };
}

/** loop-exhausted: the session ended with the "Loop ended after N turns" message */
function detectLoopExhausted(session: RawSession): WeaknessOccurrence | null {
  const lastAssistant = [...session.history].reverse().find(m => m.role === 'assistant');
  if (!lastAssistant || !('content' in lastAssistant)) return null;

  const content = String(lastAssistant.content ?? '');
  if (!content.includes('Loop ended after') && !content.includes('maxTurns')) return null;

  return {
    sessionId: session.id ?? '(unknown)',
    sessionTitle: session.title ?? '(untitled)',
    exampleTask: getUserTask(session.history),
    exampleFailure: `Loop exhausted: ${content.slice(0, 150)}`,
    timestamp: getTimestamp(session),
  };
}

/** safety-false-positive: run_shell was blocked on a harmless command */
function detectSafetyFalsePositive(session: RawSession): WeaknessOccurrence[] {
  const results = collectToolResults(session.history);
  const calls = collectToolCalls(session.history);
  const occurrences: WeaknessOccurrence[] = [];

  for (const result of results) {
    if (!result.isError) continue;
    const content = result.content.toLowerCase();
    if (!content.includes('blocked') && !content.includes('dangerous') && !content.includes('not allowed')) continue;

    // Find the matching call to get the command
    const matchingCall = calls.find(c => c.id === result.id);
    if (!matchingCall || matchingCall.name !== 'run_shell') continue;

    const cmd = String((matchingCall.input as Record<string, unknown>).command ?? '');
    const isHarmless = HARMLESS_COMMANDS.some(h => cmd.toLowerCase().trim().startsWith(h));

    if (isHarmless) {
      occurrences.push({
        sessionId: session.id ?? '(unknown)',
        sessionTitle: session.title ?? '(untitled)',
        exampleTask: getUserTask(session.history),
        exampleFailure: `Harmless command "${cmd.slice(0, 80)}" was blocked by safety system: ${result.content.slice(0, 100)}`,
        timestamp: getTimestamp(session),
      });
    }
  }

  return occurrences;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt patch suggestions
// ─────────────────────────────────────────────────────────────────────────────

const PROMPT_PATCHES: Record<PatternName, string> = {
  'no-tool-calls':
    'PATCH: Add to system prompt — "Never respond to a task with only prose. Always begin by using at least one tool (search_code, read_file, or list_dir) to investigate the codebase before summarizing or concluding. A response with zero tool calls is almost always incomplete."',
  'file-not-created':
    'PATCH: Add to system prompt — "After calling write_file, verify the file exists by reading it back or checking with list_dir. If write_file fails, diagnose the error (permission, missing parent dir) and retry with the fix. Never move on after a failed write without attempting recovery."',
  'explored-not-executed':
    'PATCH: Add to system prompt — "If the task requires a code change, you must eventually call write_file or edit_file to apply it. Do not spend all turns on read_file and search_code — at some point you must commit to making the change. Aim for a 2:1 ratio of reads to writes, not 100% reads."',
  'test-regression':
    'PATCH: Add to system prompt — "When run_tests reports new failures you did not expect, immediately investigate and fix them before proceeding. Never leave the codebase in a state with more test failures than you started with. If you introduced a regression, roll back your change or fix it before moving on."',
  'loop-exhausted':
    'PATCH: Add to system prompt — "Work efficiently. Do not repeat the same tool calls. If you have made 3+ attempts at the same approach without progress, try a fundamentally different strategy. Prioritize completing the task over perfect completion — a working partial solution is better than an exhausted loop."',
  'safety-false-positive':
    'PATCH: Review DANGEROUS_PATTERNS and SAFE_SHELL_COMMANDS in config/defaults.ts. The safety system is blocking commands that are harmless. Add the blocked command prefix to SAFE_SHELL_COMMANDS, or refine the regex in DANGEROUS_PATTERNS to avoid over-matching. Consider allowing mkdir, touch, and other common file-manipulation commands without confirmation.',
};

// ─────────────────────────────────────────────────────────────────────────────
// Main miner
// ─────────────────────────────────────────────────────────────────────────────

export function mineWeaknesses(customDir?: string): WeaknessReport {
  const dir = customDir ?? sessionDir();
  const sessions = loadAllSessions(dir);

  const rawOccurrences: Record<PatternName, WeaknessOccurrence[]> = {
    'no-tool-calls': [],
    'file-not-created': [],
    'explored-not-executed': [],
    'test-regression': [],
    'loop-exhausted': [],
    'safety-false-positive': [],
  };

  for (const session of sessions) {
    const noTool = detectNoToolCalls(session);
    if (noTool) rawOccurrences['no-tool-calls'].push(noTool);

    rawOccurrences['file-not-created'].push(...detectFileNotCreated(session));

    const explored = detectExploredNotExecuted(session);
    if (explored) rawOccurrences['explored-not-executed'].push(explored);

    const regression = detectTestRegression(session);
    if (regression) rawOccurrences['test-regression'].push(regression);

    const exhausted = detectLoopExhausted(session);
    if (exhausted) rawOccurrences['loop-exhausted'].push(exhausted);

    rawOccurrences['safety-false-positive'].push(...detectSafetyFalsePositive(session));
  }

  // Only include patterns with 2+ occurrences
  const patterns: PatternReport[] = [];
  for (const [name, occurrences] of Object.entries(rawOccurrences) as [PatternName, WeaknessOccurrence[]][]) {
    if (occurrences.length < 2) continue;
    patterns.push({
      pattern: name,
      frequency: occurrences.length,
      description: PATTERN_DESCRIPTIONS[name],
      occurrences,
      promptPatch: PROMPT_PATCHES[name],
    });
  }

  // Sort by frequency descending
  patterns.sort((a, b) => b.frequency - a.frequency);

  const totalWeaknesses = patterns.reduce((sum, p) => sum + p.frequency, 0);
  const summary = patterns.length === 0
    ? 'No recurring weakness patterns detected across all sessions. Agent behavior looks healthy.'
    : `Found ${patterns.length} recurring pattern(s) across ${sessions.length} session(s) with ${totalWeaknesses} total occurrences. Top issue: ${patterns[0]?.pattern} (${patterns[0]?.frequency}x).`;

  return {
    generatedAt: new Date().toISOString(),
    sessionsAnalyzed: sessions.length,
    patterns,
    summary,
  };
}

const PATTERN_DESCRIPTIONS: Record<PatternName, string> = {
  'no-tool-calls': 'Agent responded with prose only — no tool calls were made to investigate or solve the task.',
  'file-not-created': 'Agent called write_file but the operation failed (file not created on disk).',
  'explored-not-executed': 'Agent only performed read operations (read_file, search_code, list_dir) without writing or executing anything.',
  'test-regression': 'Agent introduced new test failures during the session.',
  'loop-exhausted': 'Agent loop hit the max turn limit without completing the task.',
  'safety-false-positive': 'Safety system blocked a harmless shell command, preventing the agent from working.',
};

// ─────────────────────────────────────────────────────────────────────────────
// Report persistence
// ─────────────────────────────────────────────────────────────────────────────

export function reportPath(): string {
  return path.join(process.env.HOME ?? '/tmp', '.aura', 'harness', 'weakness-report.json');
}

export function saveReport(report: WeaknessReport, customPath?: string): string {
  const filePath = customPath ?? reportPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
  return filePath;
}

export function loadReport(customPath?: string): WeaknessReport | null {
  const filePath = customPath ?? reportPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as WeaknessReport;
  } catch {
    return null;
  }
}
