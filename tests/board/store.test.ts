import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  addTask, attachmentsDir, boardPath, loadBoard, removeAttachments, removeTask,
  saveAttachment, saveBoard, tasksIn, taskPrompt, updateTask,
} from '../../src/board/store.js';
import { EMPTY_BOARD, type BoardState } from '../../src/board/types.js';

/**
 * The board is the one thing here a person authors by hand, so losing it is
 * losing work they cannot reconstruct from the repo. These tests are mostly
 * about not losing it.
 */

let home: string;
let project: string;
const prevHome = process.env.AURA_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-board-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-board-proj-'));
  process.env.AURA_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AURA_HOME;
  else process.env.AURA_HOME = prevHome;
  for (const d of [home, project]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('where the board is kept', () => {
  it('lives in the state directory, never in the user\'s project', () => {
    // A file written into the checkout shows up in their `git status` as
    // something they did not create, which is how a tool loses trust.
    const file = boardPath(project);
    expect(file.startsWith(home)).toBe(true);
    expect(file.startsWith(project)).toBe(false);
  });

  it('gives two projects with the same basename different boards', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'y-'));
    fs.mkdirSync(path.join(a, 'api'));
    fs.mkdirSync(path.join(b, 'api'));
    expect(boardPath(path.join(a, 'api'))).not.toBe(boardPath(path.join(b, 'api')));
    for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('reading and writing', () => {
  it('returns an empty board before anything is saved', () => {
    expect(loadBoard(project)).toEqual(EMPTY_BOARD);
  });

  it('round-trips a saved board', () => {
    const state: BoardState = { version: 1, tasks: [] };
    addTask(state, { title: 'Write the release notes', agent: 'researcher' });
    saveBoard(project, state);

    const back = loadBoard(project);
    expect(back.tasks).toHaveLength(1);
    expect(back.tasks[0].title).toBe('Write the release notes');
    expect(back.tasks[0].agent).toBe('researcher');
  });

  it('survives a corrupt file instead of taking the server down', () => {
    // The board is a convenience. Refusing to start the web client over one
    // bad JSON file would be a worse failure than losing some tiles.
    const file = boardPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json');
    expect(loadBoard(project)).toEqual(EMPTY_BOARD);
    // And the bad file is left alone, so it can be recovered by hand.
    expect(fs.readFileSync(file, 'utf8')).toBe('{ this is not json');
  });

  it('repairs a task with an unknown column rather than hiding it', () => {
    // A hand-edited file with a bad column would otherwise leave the task
    // present in the data and invisible on screen — the worst of both.
    const file = boardPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      tasks: [{ id: 'a', title: 'Stray', column: 'nowhere', agent: 'wizard', order: 0 }],
    }));
    const back = loadBoard(project);
    expect(back.tasks[0].column).toBe('planning');
    expect(back.tasks[0].agent).toBe('aura');
  });

  it('writes atomically, leaving no temp file behind', () => {
    const state: BoardState = { version: 1, tasks: [] };
    addTask(state, { title: 'One' });
    saveBoard(project, state);
    const dir = path.dirname(boardPath(project));
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});

describe('editing tasks', () => {
  let state: BoardState;
  beforeEach(() => { state = { version: 1, tasks: [] }; });

  it('adds to planning by default', () => {
    const task = addTask(state, { title: 'Draft the plan' });
    expect(task.column).toBe('planning');
    expect(task.agent).toBe('aura');
  });

  it('spaces orders so a task can later be dropped between two others', () => {
    const a = addTask(state, { title: 'A' });
    const b = addTask(state, { title: 'B' });
    expect(b.order - a.order).toBeGreaterThan(1);
    // Which is the point: a midpoint exists without renumbering the column.
    expect(Math.floor((a.order + b.order) / 2)).toBeGreaterThan(a.order);
  });

  it('changes the agent, which is the whole point of the picker', () => {
    const task = addTask(state, { title: 'Review the diff' });
    updateTask(state, task.id, { agent: 'reviewer' });
    expect(state.tasks[0].agent).toBe('reviewer');
  });

  it('routes one task to a different model without touching the others', () => {
    const cheap = addTask(state, { title: 'Summarise' });
    addTask(state, { title: 'Refactor' });
    updateTask(state, cheap.id, { model: 'gemini/gemini-2.5-flash' });
    expect(state.tasks[0].model).toBe('gemini/gemini-2.5-flash');
    expect(state.tasks[1].model).toBeUndefined();
  });

  it('does not erase notes when only the column moves', () => {
    // Spreading the patch wholesale would let an absent key overwrite a
    // present value with undefined — the bug this guards.
    const task = addTask(state, { title: 'Ship it', notes: 'remember the changelog' });
    updateTask(state, task.id, { column: 'execution' });
    expect(state.tasks[0].notes).toBe('remember the changelog');
    expect(state.tasks[0].column).toBe('execution');
  });

  it('refuses an unknown column or agent rather than storing it', () => {
    const task = addTask(state, { title: 'Careful' });
    updateTask(state, task.id, { column: 'nonsense' as never, agent: 'hacker' as never });
    expect(state.tasks[0].column).toBe('planning');
    expect(state.tasks[0].agent).toBe('aura');
  });

  it('reports an unknown id instead of quietly creating a task', () => {
    expect(updateTask(state, 'no-such-id', { title: 'ghost' })).toBeNull();
    expect(state.tasks).toHaveLength(0);
  });

  it('clears a model override when set to empty', () => {
    const task = addTask(state, { title: 'x', model: 'gemini/gemini-2.5-flash' });
    updateTask(state, task.id, { model: '' });
    expect(state.tasks[0].model).toBeUndefined();
  });

  it('removes a task, and says whether it was there', () => {
    const task = addTask(state, { title: 'Temporary' });
    expect(removeTask(state, task.id)).toBe(true);
    expect(removeTask(state, task.id)).toBe(false);
    expect(state.tasks).toHaveLength(0);
  });

  it('touches updatedAt on every edit', () => {
    const task = addTask(state, { title: 'x' });
    const before = task.updatedAt;
    updateTask(state, task.id, { title: 'y' });
    expect(state.tasks[0].updatedAt >= before).toBe(true);
  });
});

describe('columns', () => {
  it('returns each column in order', () => {
    const state: BoardState = { version: 1, tasks: [] };
    const a = addTask(state, { title: 'first' });
    const b = addTask(state, { title: 'second' });
    updateTask(state, a.id, { order: 5000 });
    expect(tasksIn(state, 'planning').map((t) => t.title)).toEqual(['second', 'first']);
    expect(tasksIn(state, 'finished')).toEqual([]);
    expect(b.column).toBe('planning');
  });
});

describe('what gets sent to the agent', () => {
  it('joins the title and the notes, because the instruction is usually in the notes', () => {
    const state: BoardState = { version: 1, tasks: [] };
    const task = addTask(state, { title: 'Fix the parser', notes: 'It drops trailing commas.' });
    expect(taskPrompt(task)).toBe('Fix the parser\n\nIt drops trailing commas.');
  });

  it('sends the title alone when there are no notes', () => {
    const state: BoardState = { version: 1, tasks: [] };
    const task = addTask(state, { title: '  Fix the parser  ' });
    expect(taskPrompt(task)).toBe('Fix the parser');
  });
});

describe('attachments', () => {
  it('writes the file beside the board, never into the project', () => {
    const a = saveAttachment(project, 'task1', {
      name: 'shot.png', type: 'image/png', data: Buffer.from('bytes'),
    });
    expect(a.path.startsWith(home)).toBe(true);
    expect(a.path.startsWith(project)).toBe(false);
    expect(fs.readFileSync(a.path, 'utf8')).toBe('bytes');
    expect(a.size).toBe(5);
  });

  it('refuses to let a filename escape the attachment directory', () => {
    // The name comes from a browser file picker. Used verbatim, `../../` would
    // let an upload land anywhere the process can write — the one place a
    // path from outside must never be trusted.
    const a = saveAttachment(project, 'task1', {
      name: '../../../.bashrc', type: 'text/plain', data: Buffer.from('x'),
    });
    expect(a.path.startsWith(attachmentsDir(project, 'task1'))).toBe(true);
    expect(a.name).not.toContain('..');
    expect(a.name).not.toContain('/');
  });

  it('keeps two files that share a name', () => {
    // Two screenshots are both called "Screenshot.png" and are not the same
    // attachment; overwriting one with the other loses the user's file.
    const first = saveAttachment(project, 't', { name: 'Screenshot.png', type: 'image/png', data: Buffer.from('one') });
    const second = saveAttachment(project, 't', { name: 'Screenshot.png', type: 'image/png', data: Buffer.from('two') });
    expect(second.path).not.toBe(first.path);
    expect(fs.readFileSync(first.path, 'utf8')).toBe('one');
    expect(fs.readFileSync(second.path, 'utf8')).toBe('two');
  });

  it('removes the files of a deleted task', () => {
    const a = saveAttachment(project, 'doomed', { name: 'f.txt', type: 'text/plain', data: Buffer.from('x') });
    expect(fs.existsSync(a.path)).toBe(true);
    removeAttachments(project, 'doomed');
    expect(fs.existsSync(a.path)).toBe(false);
  });

  it('does not throw when there is nothing to remove', () => {
    expect(() => removeAttachments(project, 'never-existed')).not.toThrow();
  });

  it('names attachments by path in the prompt, never by content', () => {
    // The agent has read_file and image_read. Handing it a path it can open
    // beats inlining bytes it cannot inspect — and keeps a 20MB screenshot out
    // of the prompt entirely.
    const state: BoardState = { version: 1, tasks: [] };
    const task = addTask(state, { title: 'Look at this' });
    updateTask(state, task.id, {
      attachments: [{ name: 'shot.png', type: 'image/png', size: 10, path: '/tmp/shot.png' }],
    });
    const prompt = taskPrompt(state.tasks[0]);
    expect(prompt).toContain('/tmp/shot.png');
    expect(prompt).toMatch(/read_file|image_read/);
  });

  it('leaves the prompt alone when there are no attachments', () => {
    const state: BoardState = { version: 1, tasks: [] };
    const task = addTask(state, { title: 'Plain' });
    expect(taskPrompt(task)).toBe('Plain');
  });
});
