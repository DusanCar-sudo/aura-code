import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// vi.hoisted() ensures TEST_TMP is initialized before the hoisted vi.mock() runs,
// avoiding a TDZ error when telegram-safety.ts calls os.homedir() at module scope.
const TEST_TMP = vi.hoisted(() =>
  `/tmp/aura-telegram-safety-test-${Date.now()}`
);

// Mock os.homedir() before importing the module
vi.mock('os', async () => {
  const actual = await vi.importActual('os');
  return {
    ...(actual as any),
    homedir: () => TEST_TMP,
  };
});

// Re-import after mocking
import {
  loadSafetyState,
  saveSafetyState,
  safetyLabel,
  TelegramConfirmManager,
  isDestructiveTool,
  DESTRUCTIVE_TOOLS,
} from '../src/tools/telegram-safety';

describe('TelegramSafety', () => {
  beforeEach(() => {
    // Ensure clean state
    if (fs.existsSync(TEST_TMP)) {
      fs.rmSync(TEST_TMP, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_TMP, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_TMP)) {
      fs.rmSync(TEST_TMP, { recursive: true, force: true });
    }
  });

  // ── Safety state persistence ────────────────────────────────────────────

  it('defaults to safety ON when no state file exists', () => {
    const state = loadSafetyState();
    expect(state.safetyOn).toBe(true);
  });

  it('defaults to safety ON when state file is corrupt', () => {
    const statePath = path.join(TEST_TMP, '.aura', 'telegram-safety-state.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, 'not valid json', 'utf8');
    const state = loadSafetyState();
    expect(state.safetyOn).toBe(true);
  });

  it('reads persisted safety state', () => {
    saveSafetyState({ safetyOn: false });
    const state = loadSafetyState();
    expect(state.safetyOn).toBe(false);
  });

  it('round-trips safety ON', () => {
    saveSafetyState({ safetyOn: true });
    const state = loadSafetyState();
    expect(state.safetyOn).toBe(true);
  });

  it('round-trips safety OFF', () => {
    saveSafetyState({ safetyOn: false });
    const state = loadSafetyState();
    expect(state.safetyOn).toBe(false);
  });

  it('persists to the correct file path', () => {
    saveSafetyState({ safetyOn: false });
    const statePath = path.join(TEST_TMP, '.aura', 'telegram-safety-state.json');
    expect(fs.existsSync(statePath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(raw.safetyOn).toBe(false);
  });

  // ── Safety label ───────────────────────────────────────────────────────

  it('returns correct label for ON', () => {
    expect(safetyLabel(true)).toBe('[SAFETY ON]');
  });

  it('returns correct label for OFF', () => {
    expect(safetyLabel(false)).toBe('[SAFETY OFF]');
  });

  // ── Destructive tool detection ─────────────────────────────────────────

  it('detects write_file as destructive', () => {
    expect(isDestructiveTool('write_file')).toBe(true);
  });

  it('detects edit_file as destructive', () => {
    expect(isDestructiveTool('edit_file')).toBe(true);
  });

  it('detects run_shell as destructive', () => {
    expect(isDestructiveTool('run_shell')).toBe(true);
  });

  it('detects run_tests as destructive', () => {
    expect(isDestructiveTool('run_tests')).toBe(true);
  });

  it('detects cron as destructive', () => {
    expect(isDestructiveTool('cron')).toBe(true);
  });

  it('does not flag read_file as destructive', () => {
    expect(isDestructiveTool('read_file')).toBe(false);
  });

  it('does not flag search_code as destructive', () => {
    expect(isDestructiveTool('search_code')).toBe(false);
  });

  it('does not flag list_dir as destructive', () => {
    expect(isDestructiveTool('list_dir')).toBe(false);
  });

  it('does not flag web_search as destructive', () => {
    expect(isDestructiveTool('web_search')).toBe(false);
  });

  it('does not flag git_status as destructive', () => {
    expect(isDestructiveTool('git_status')).toBe(false);
  });

  it('does not flag git_diff as destructive', () => {
    expect(isDestructiveTool('git_diff')).toBe(false);
  });
});

describe('TelegramConfirmManager', () => {
  let manager: TelegramConfirmManager;

  beforeEach(() => {
    manager = new TelegramConfirmManager();
  });

  // ── Wait for approval ──────────────────────────────────────────────────

  it('creates a pending approval and returns a message', () => {
    const { promise, message } = manager.waitForApproval(
      12345,
      'write_file',
      'overwrite test.txt',
    );
    expect(promise).toBeInstanceOf(Promise);
    expect(message).toContain('write_file');
    expect(message).toContain('overwrite test.txt');
    expect(message).toContain('yes');
    expect(message).toContain('/approve');
    expect(message).toContain('5 minutes');
  });

  it('approves when user replies "yes"', async () => {
    const { promise, message } = manager.waitForApproval(
      12345,
      'run_shell',
      'touch /tmp/test',
    );

    const approvedId = manager.handleReply(12345, 'yes');
    expect(approvedId).not.toBeNull();

    const result = await promise;
    expect(result).toBe(true);
  });

  it('approves when user replies "/approve"', async () => {
    const { promise } = manager.waitForApproval(12345, 'write_file', 'overwrite x.txt');

    manager.handleReply(12345, '/approve');

    const result = await promise;
    expect(result).toBe(true);
  });

  it('approves when user replies "y"', async () => {
    const { promise } = manager.waitForApproval(12345, 'write_file', 'overwrite x.txt');

    manager.handleReply(12345, 'y');

    const result = await promise;
    expect(result).toBe(true);
  });

  it('denies when user replies "no"', async () => {
    const { promise } = manager.waitForApproval(12345, 'write_file', 'overwrite x.txt');

    manager.handleReply(12345, 'no');

    const result = await promise;
    expect(result).toBe(false);
  });

  it('denies when user replies "n"', async () => {
    const { promise } = manager.waitForApproval(12345, 'write_file', 'overwrite x.txt');

    manager.handleReply(12345, 'n');

    const result = await promise;
    expect(result).toBe(false);
  });

  it('denies when user replies "/deny"', async () => {
    const { promise } = manager.waitForApproval(12345, 'run_shell', 'rm file.txt');

    manager.handleReply(12345, '/deny');

    const result = await promise;
    expect(result).toBe(false);
  });

  it('returns null for non-approval messages', () => {
    manager.waitForApproval(12345, 'write_file', 'overwrite x.txt');

    const result = manager.handleReply(12345, 'hello world');
    expect(result).toBeNull();
  });

  it('returns null for unknown chat IDs', () => {
    manager.waitForApproval(12345, 'write_file', 'overwrite x.txt');

    const result = manager.handleReply(99999, 'yes');
    expect(result).toBeNull();
  });

  // ── Timeout ────────────────────────────────────────────────────────────

  it('times out after the specified duration', async () => {
    const { promise } = manager.waitForApproval(
      12345,
      'write_file',
      'overwrite x.txt',
      100, // 100ms timeout for fast test
    );

    const result = await promise;
    expect(result).toBe(false);
  }, 10000); // 10s test timeout

  // ── Has pending ────────────────────────────────────────────────────────

  it('detects pending approvals', () => {
    expect(manager.hasPending(12345)).toBe(false);

    manager.waitForApproval(12345, 'write_file', 'overwrite x.txt');

    expect(manager.hasPending(12345)).toBe(true);
  });

  it('clears pending after approval', () => {
    manager.waitForApproval(12345, 'write_file', 'overwrite x.txt');

    manager.handleReply(12345, 'yes');

    expect(manager.hasPending(12345)).toBe(false);
  });

  it('does not report pending for different chat', () => {
    manager.waitForApproval(12345, 'write_file', 'overwrite x.txt');

    expect(manager.hasPending(99999)).toBe(false);
  });

  // ── Pending count ──────────────────────────────────────────────────────

  it('reports correct pending count', () => {
    expect(manager.pendingCount).toBe(0);

    manager.waitForApproval(1, 'write_file', 'a.txt');
    expect(manager.pendingCount).toBe(1);

    manager.waitForApproval(1, 'write_file', 'b.txt');
    expect(manager.pendingCount).toBe(2);

    manager.handleReply(1, 'yes');
    expect(manager.pendingCount).toBe(1);
  });
});
