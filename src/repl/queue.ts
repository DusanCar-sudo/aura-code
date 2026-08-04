/**
 * :q — Persistent task queue for the REPL.
 *
 * Stores tasks in ~/.aura/queue.jsonl (append-only, atomic .tmp+rename on mutations).
 * Each line is a JSON object with { id, prompt, createdAt, status }.
 *
 * Commands (dispatched from cli/index.ts):
 *   :q add <prompt>   — enqueue a task
 *   :q list           — show all items with index
 *   :q run <n>        — execute item n in a fresh agent loop
 *   :q drop <n>       — remove item n
 *   :q clear          — wipe the queue (with confirmation)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import chalk from 'chalk';
import type { LLMProvider } from '../providers/types.js';
import { runAgentLoop } from '../agent/loop.js';
import type { ProjectContext } from '../agent/context.js';
import { createTerminalDisplay } from '../cli/display.js';
import { PermissionSystem } from '../safety/permissions.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface QueueItem {
  id: string;
  prompt: string;
  createdAt: number;
  status: 'pending' | 'running' | 'done' | 'failed';
}

// ── Storage ─────────────────────────────────────────────────────────────────

function queuePath(): string {
  return path.join(os.homedir(), '.aura', 'queue.jsonl');
}

export function loadQueue(): QueueItem[] {
  const p = queuePath();
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map(line => JSON.parse(line) as QueueItem);
}

function saveQueue(items: QueueItem[]): void {
  const p = queuePath();
  const tmp = p + '.tmp';
  const data = items.map(i => JSON.stringify(i)).join('\n') + '\n';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, p);
}

export function addToQueue(prompt: string): QueueItem {
  const items = loadQueue();
  const item: QueueItem = {
    id: crypto.randomUUID().slice(0, 8),
    prompt,
    createdAt: Date.now(),
    status: 'pending',
  };
  // Append a single line (atomic enough — .tmp+rename on the whole file is done in saveQueue)
  items.push(item);
  saveQueue(items);
  return item;
}

export function removeFromQueue(index: number): QueueItem | null {
  const items = loadQueue();
  if (index < 0 || index >= items.length) return null;
  const removed = items.splice(index, 1)[0];
  saveQueue(items);
  return removed;
}

export function clearQueue(): number {
  const count = loadQueue().length;
  saveQueue([]);
  return count;
}

// ── Execution ───────────────────────────────────────────────────────────────

export interface QueueRunResult {
  success: boolean;
  output: string;
  turns: number;
  toolCalls: number;
}

export async function runQueueItem(
  index: number,
  provider: LLMProvider,
  ctx: ProjectContext,
  permissions: PermissionSystem,
  display: ReturnType<typeof createTerminalDisplay>,
): Promise<QueueRunResult | null> {
  const items = loadQueue();
  if (index < 0 || index >= items.length) return null;

  const item = items[index];
  item.status = 'running';
  saveQueue(items);

  try {
    // Run a fresh agent loop for this task.
    const result = await runAgentLoop({
      provider,
      task: item.prompt,
      context: ctx,
      permissions,
      display,
      maxTurns: 25,
    });

    item.status = result.success ? 'done' : 'failed';
    saveQueue(items);

    return {
      success: result.success,
      output: result.summary,
      turns: result.turns ?? 0,
      toolCalls: result.toolCallCount ?? 0,
    };
  } catch (err) {
    item.status = 'failed';
    saveQueue(items);
    return {
      success: false,
      output: String(err),
      turns: 0,
      toolCalls: 0,
    };
  }
}

// ── Formatting (for REPL display) ───────────────────────────────────────────

export function formatQueue(items: QueueItem[]): string {
  if (items.length === 0) return chalk.hex('#8a7768')('\n  Queue is empty. Use :q add <prompt> to enqueue a task.\n');

  const lines = items.map((item, i) => {
    const statusColor: Record<string, string> = {
      pending: '#8a7768',
      running: '#d4903a',
      done:    '#5a9e6e',
      failed:  '#b15439',
    };
    const color = statusColor[item.status] || '#8a7768';
    const statusIcon = item.status === 'done' ? '✓' : item.status === 'running' ? '⟳' : item.status === 'failed' ? '✗' : '·';
    const created = new Date(item.createdAt).toLocaleTimeString();
    return `  ${chalk.hex('#cc785c')(String(i + 1).padEnd(3))} ${chalk.hex(color)(statusIcon)} ${chalk.hex('#ede0cc')(item.prompt.slice(0, 80))} ${chalk.hex('#4e3d30')(created)}`;
  });
  return `\n${lines.join('\n')}\n`;
}
