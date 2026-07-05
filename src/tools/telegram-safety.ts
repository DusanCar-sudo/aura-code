import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Safety state management
// ─────────────────────────────────────────────────────────────────────────────

const SAFETY_STATE_FILE = path.join(os.homedir(), '.aura', 'telegram-safety-state.json');

export interface SafetyState {
  safetyOn: boolean;
}

/** Load safety state from disk. Defaults to ON if file missing or corrupt. */
export function loadSafetyState(): SafetyState {
  try {
    if (fs.existsSync(SAFETY_STATE_FILE)) {
      const raw = fs.readFileSync(SAFETY_STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.safetyOn === 'boolean') {
        return { safetyOn: parsed.safetyOn };
      }
    }
  } catch {
    // corrupt file — fall through to default
  }
  return { safetyOn: true };
}

/** Persist safety state to disk. */
export function saveSafetyState(state: SafetyState): void {
  const dir = path.dirname(SAFETY_STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SAFETY_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Returns the safety label prefix string.
 * e.g. "[SAFETY ON]" or "[SAFETY OFF]"
 */
export function safetyLabel(safetyOn: boolean): string {
  return safetyOn ? '[SAFETY ON]' : '[SAFETY OFF]';
}

// ─────────────────────────────────────────────────────────────────────────────
// Destructive tool detection
// ─────────────────────────────────────────────────────────────────────────────

/** Tools that modify the filesystem or run shell commands. */
export const DESTRUCTIVE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'run_shell',
  'run_tests',
  'cron',
]);

/** Check if a tool name is considered destructive (requires safety confirmation). */
export function isDestructiveTool(toolName: string): boolean {
  return DESTRUCTIVE_TOOLS.has(toolName);
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram-based confirmation manager
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingApproval {
  chatId: number;
  toolName: string;
  description: string;
  resolve: (approved: boolean) => void;
  reject: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Manages pending tool approvals via Telegram.
 * Each destructive tool call creates a PendingApproval that waits
 * for the user to reply "yes" or "/approve" (approve) or "no" (reject).
 */
export class TelegramConfirmManager {
  private pending = new Map<string, PendingApproval>();
  private nextId = 1;

  /**
   * Register a pending approval and return a promise that resolves when
   * the user replies (or times out).
   *
   * The caller receives the promise + the message text to send to Telegram.
   */
  waitForApproval(
    chatId: number,
    toolName: string,
    description: string,
    timeoutMs: number = 5 * 60 * 1000,
  ): { promise: Promise<boolean>; message: string } {
    const id = `approve_${this.nextId++}`;
    let resolveFn: (approved: boolean) => void = () => {};
    let rejectFn: (reason: string) => void = () => {};

    const promise = new Promise<boolean>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const timer = setTimeout(() => {
      this.pending.delete(id);
      resolveFn(false);
    }, timeoutMs);

    const approval: PendingApproval = {
      chatId,
      toolName,
      description,
      resolve: (approved: boolean) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolveFn(approved);
      },
      reject: (reason: string) => {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectFn(reason);
      },
      timer,
    };

    this.pending.set(id, approval);

    const message = [
      `⚠️ **Approval needed** — ${toolName}`,
      '',
      `\`${description}\``,
      '',
      `Reply \`yes\` or \`/approve\` to allow, \`no\` to deny.`,
      `Auto-cancels in 5 minutes.`,
    ].join('\n');

    return { promise, message };
  }

  /**
   * Handle a potential approval/rejection reply.
   * Returns the approval id if matched, or null if not a confirmation reply.
   */
  handleReply(chatId: number, text: string): string | null {
    const lower = text.toLowerCase().trim();

    // Find the most recent pending approval for this chat
    let latestId: string | null = null;
    let latestApproval: PendingApproval | null = null;

    // Iterate to find the last entry for this chatId
    for (const [id, approval] of this.pending) {
      if (approval.chatId === chatId) {
        latestId = id;
        latestApproval = approval;
      }
    }

    if (!latestApproval || !latestId) return null;

    if (lower === 'yes' || lower === '/approve' || lower === 'y') {
      latestApproval.resolve(true);
      return latestId;
    }

    if (lower === 'no' || lower === 'n' || lower === '/deny') {
      latestApproval.resolve(false);
      return latestId;
    }

    return null;
  }

  /** Check if there's a pending approval for a given chat. */
  hasPending(chatId: number): boolean {
    for (const approval of this.pending.values()) {
      if (approval.chatId === chatId) return true;
    }
    return false;
  }

  /** Get count of pending approvals. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
