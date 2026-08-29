/**
 * Where the board lives.
 *
 * One JSON file per project, under the state directory rather than inside the
 * project itself. Two reasons: AURA.md is explicit that only the package
 * belongs in a checkout, and a board written into the working tree would show
 * up in the user's `git status` as a file they did not create — which is how a
 * tool loses trust.
 *
 * Every write is atomic (temp file, then rename) because the board is edited
 * from a browser while an agent may be finishing a task in the same process. A
 * torn write here loses the user's planning, which they cannot reconstruct.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { auraPath } from '../util/aura-home.js';
import {
  EMPTY_BOARD, isBoardAgent, isBoardColumn,
  type BoardAgent, type BoardAttachment, type BoardColumn, type BoardState, type BoardTask,
} from './types.js';

/**
 * The board file for a project root.
 *
 * Named by a hash of the resolved path, with a readable prefix so the
 * directory can be browsed by a human. Two projects with the same basename —
 * `~/work/api` and `~/scratch/api` — must not share a board, which a
 * basename-only name would let happen.
 */
export function boardPath(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12);
  const slug = path.basename(resolved).replace(/[^\w.-]+/g, '-').slice(0, 40) || 'project';
  return auraPath('boards', `${slug}-${hash}.json`);
}

/**
 * Read the board, or an empty one.
 *
 * Never throws. A corrupt or unreadable file yields an empty board rather than
 * taking the server down — the board is a convenience, and refusing to start
 * the web client over a bad JSON file would be a worse failure than losing
 * some tiles. The bad file is left on disk untouched so it can be recovered by
 * hand.
 */
export function loadBoard(projectRoot: string): BoardState {
  try {
    const raw = fs.readFileSync(boardPath(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as BoardState;
    if (!parsed || !Array.isArray(parsed.tasks)) return { ...EMPTY_BOARD };
    // Filter rather than trust: the file is editable by hand, and one bad
    // column value would otherwise render a task into no column at all —
    // present in the data, invisible on screen.
    return { version: 1, tasks: parsed.tasks.filter(isTask).map(normalize) };
  } catch {
    return { ...EMPTY_BOARD };
  }
}

function isTask(t: unknown): t is BoardTask {
  return !!t && typeof t === 'object'
    && typeof (t as BoardTask).id === 'string'
    && typeof (t as BoardTask).title === 'string';
}

function normalize(t: BoardTask): BoardTask {
  return {
    ...t,
    column: isBoardColumn(t.column) ? t.column : 'planning',
    agent: isBoardAgent(t.agent) ? t.agent : 'aura',
    order: Number.isFinite(t.order) ? t.order : 0,
    createdAt: t.createdAt ?? new Date().toISOString(),
    updatedAt: t.updatedAt ?? new Date().toISOString(),
  };
}

/** Write the board atomically. */
export function saveBoard(projectRoot: string, state: BoardState): void {
  const file = boardPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Same directory as the target, so the rename is on one filesystem and is
  // therefore atomic. A temp file in /tmp would make this a copy, which can
  // tear exactly like the write it is meant to replace.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Where a task's attachments are kept. Beside the board, never in the project. */
export function attachmentsDir(projectRoot: string, taskId: string): string {
  return path.join(path.dirname(boardPath(projectRoot)), 'attachments', taskId);
}

/**
 * Write one attachment to disk and return its record.
 *
 * The filename is sanitised rather than trusted. It arrives from a browser
 * file picker, and a name like `../../.bashrc` would otherwise let an upload
 * land anywhere the process can write — the one place a path from outside must
 * never be used verbatim.
 */
export function saveAttachment(
  projectRoot: string,
  taskId: string,
  file: { name: string; type: string; data: Buffer },
): BoardAttachment {
  const safe = path.basename(file.name).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'attachment';
  const dir = attachmentsDir(projectRoot, taskId);
  fs.mkdirSync(dir, { recursive: true });
  // Collisions are resolved rather than overwritten: two screenshots both
  // called "Screenshot.png" are two different attachments.
  let target = path.join(dir, safe);
  if (fs.existsSync(target)) {
    const ext = path.extname(safe);
    target = path.join(dir, `${path.basename(safe, ext)}-${Date.now().toString(36)}${ext}`);
  }
  fs.writeFileSync(target, file.data, { mode: 0o600 });
  return { name: path.basename(target), type: file.type, size: file.data.length, path: target };
}

/** Delete a task's attachment directory. Best-effort — a leftover file is not
 *  worth failing a delete over. */
export function removeAttachments(projectRoot: string, taskId: string): void {
  try { fs.rmSync(attachmentsDir(projectRoot, taskId), { recursive: true, force: true }); }
  catch { /* best effort */ }
}

/** A short, collision-resistant task id. */
export function newTaskId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export interface TaskPatch {
  attachments?: BoardAttachment[];
  priority?: 'normal' | 'urgent';
  attention?: boolean;
  linkedTo?: string;
  title?: string;
  notes?: string;
  column?: BoardColumn;
  agent?: BoardAgent;
  model?: string;
  sessionId?: string;
  result?: string;
  failed?: boolean;
  order?: number;
}

/**
 * Create a task at the end of its column.
 *
 * Order is sparse (steps of 1000) so a task can later be dropped between two
 * neighbours by averaging their orders, without renumbering the column. Dense
 * integers would force a rewrite of every sibling on each move, which is both
 * more code and more chances to lose one.
 */
export function addTask(state: BoardState, patch: TaskPatch & { title: string }): BoardTask {
  const column = patch.column ?? 'planning';
  const last = state.tasks
    .filter((t) => t.column === column)
    .reduce((max, t) => Math.max(max, t.order), 0);
  const now = new Date().toISOString();
  const task: BoardTask = {
    id: newTaskId(),
    title: patch.title,
    notes: patch.notes,
    column,
    agent: patch.agent ?? 'aura',
    model: patch.model,
    order: last + 1000,
    createdAt: now,
    updatedAt: now,
  };
  state.tasks.push(task);
  return task;
}

/**
 * Apply a patch to one task. Returns the updated task, or null if the id is
 * unknown — an unknown id is the client and server disagreeing about what
 * exists, which the caller should report rather than silently create.
 */
export function updateTask(state: BoardState, id: string, patch: TaskPatch): BoardTask | null {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return null;

  // Only assign what was actually sent. Spreading the patch wholesale would
  // let an absent key overwrite a present value with undefined — which is how
  // moving a tile would silently erase its notes.
  if (patch.title !== undefined) task.title = patch.title;
  if (patch.notes !== undefined) task.notes = patch.notes;
  if (patch.column !== undefined && isBoardColumn(patch.column)) task.column = patch.column;
  if (patch.agent !== undefined && isBoardAgent(patch.agent)) task.agent = patch.agent;
  if (patch.model !== undefined) task.model = patch.model || undefined;
  if (patch.sessionId !== undefined) task.sessionId = patch.sessionId;
  if (patch.result !== undefined) task.result = patch.result;
  if (patch.failed !== undefined) task.failed = patch.failed;
  if (patch.order !== undefined) task.order = patch.order;
  if (patch.attachments !== undefined) task.attachments = patch.attachments;
  if (patch.priority !== undefined) task.priority = patch.priority;
  if (patch.attention !== undefined) task.attention = patch.attention;
  // An empty string clears the link, so a connector can be removed as easily
  // as it was made.
  if (patch.linkedTo !== undefined) task.linkedTo = patch.linkedTo || undefined;
  task.updatedAt = new Date().toISOString();
  return task;
}

/** Remove a task. Returns whether it was there. */
export function removeTask(state: BoardState, id: string): boolean {
  const at = state.tasks.findIndex((t) => t.id === id);
  if (at < 0) return false;
  state.tasks.splice(at, 1);
  return true;
}

/**
 * Return tasks stranded mid-run to `preparation`, and say how many.
 *
 * A task in `execution` means a turn is running for it. Nothing is running the
 * instant the engine starts, so any task found there was cut off — by a
 * restart, a crash, or a Ctrl+C. Leaving it would park the tile in Execution
 * for ever with no control that moves it, which is exactly the state a user
 * cannot get out of.
 *
 * It goes back to `preparation` rather than `finished` because the work did
 * not happen: the next thing the user wants is the Run button, not a result
 * that does not exist.
 */
export function reclaimStrandedTasks(state: BoardState): number {
  let found = 0;
  for (const task of state.tasks) {
    if (task.column !== 'execution') continue;
    task.column = 'preparation';
    task.failed = true;
    task.result = 'The run was interrupted before it finished — the engine restarted while this task was in flight. Run it again.';
    task.updatedAt = new Date().toISOString();
    found++;
  }
  return found;
}

/**
 * Tasks of one column, in display order.
 *
 * The first three columns are ordered by `order`, which the operator sets by
 * moving a tile: where something sits in a plan is a judgement, and the board
 * should keep it.
 *
 * `finished` is different on purpose. It is a record of what happened, and the
 * order things happened in is not the operator's to arrange — so it is sorted
 * by completion, newest last, and dragging within it does nothing.
 */
export function tasksIn(state: BoardState, column: BoardColumn): BoardTask[] {
  const of = state.tasks.filter((t) => t.column === column);
  if (column === 'finished') {
    return of.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }
  return of.sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

/**
 * The order value that puts a task between two neighbours.
 *
 * Averaging is why `addTask` spaces orders by 1000: a tile can be dropped
 * between any two others without renumbering the column, which would be more
 * code and more chances to lose one. When the gap closes to nothing the
 * caller renumbers, which is rare enough to be worth the simplicity.
 */
export function orderBetween(before: BoardTask | undefined, after: BoardTask | undefined): number {
  if (!before && !after) return 1000;
  if (!before) return after!.order - 1000;
  if (!after) return before.order + 1000;
  return (before.order + after.order) / 2;
}

/**
 * The text sent to the agent when a task is dispatched.
 *
 * Title and notes joined, because the title alone is a label and the notes are
 * where the actual instruction usually lives. The specialist is not named in
 * the prompt — that is routing, and putting it in the text as well would let a
 * task argue with its own dispatch.
 */
export function taskPrompt(task: BoardTask): string {
  const notes = task.notes?.trim();
  const body = notes ? `${task.title.trim()}\n\n${notes}` : task.title.trim();
  if (!task.attachments?.length) return body;
  // Paths, not contents. The agent has read_file and image_read; naming the
  // file it can open beats inlining bytes it cannot inspect, and keeps a
  // twenty-megabyte screenshot out of the prompt.
  const list = task.attachments.map((a) => `- ${a.path}`).join('\n');
  return `${body}\n\nAttached files (read them with read_file or image_read):\n${list}`;
}
