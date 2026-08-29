import { describe, it, expect } from 'vitest';
import { buildBoard, detailFor, COLUMNS, type Column } from '../../web/src/lib/board.js';
import type { Message, ToolEvent } from '../../web/src/hooks/useAura.js';

/**
 * The board is a projection, not a store — that is the whole design, and the
 * previous Kanban died because it was the other way round. These tests pin the
 * projection, because if it drifts the board starts describing a run that did
 * not happen, which is worse than having no board.
 *
 * The columns are states work passes through, so most of what matters here is
 * *movement*: the same card in the right place at each stage of a run.
 */

let seq = 0;
const tool = (name: string, extra: Partial<ToolEvent> = {}): ToolEvent =>
  ({ id: `${name}-${seq++}`, name, ...extra });

const assistant = (tools: ToolEvent[], extra: Partial<Message> = {}): Message => ({
  id: `m${seq++}`, role: 'assistant', text: '', tools, at: 0, ...extra,
});

const at = (b: ReturnType<typeof buildBoard>, c: Column) =>
  b.columns.find((x) => x.column === c)!.cards;

describe('card detail', () => {
  it('picks the argument that identifies the call', () => {
    expect(detailFor({ path: 'src/agent/loop.ts' })).toBe('src/agent/loop.ts');
    expect(detailFor({ command: 'npm test' })).toBe('npm test');
    expect(detailFor({ query: 'kanban' })).toBe('kanban');
  });

  it('shows nothing rather than dumping JSON', () => {
    // A card is a glance. An unreadable card is worse than a bare one.
    expect(detailFor({ weird: { nested: true } })).toBeUndefined();
    expect(detailFor(undefined)).toBeUndefined();
    expect(detailFor({ path: '   ' })).toBeUndefined();
  });
});

describe('the board', () => {
  it('always has the four columns of the flow, even when empty', () => {
    const board = buildBoard([]);
    expect(board.columns.map((c) => c.column)).toEqual([...COLUMNS]);
    expect(board.total).toBe(0);
  });

  it('ignores user messages — a card means the agent has work', () => {
    expect(buildBoard([{ id: 'u1', role: 'user', text: 'go', tools: [], at: 0 }]).total).toBe(0);
  });
});

/**
 * One turn, followed across the board. This is the sequence a person watches,
 * so it is the sequence that has to be right.
 */
describe('work moving through the flow', () => {
  it('starts in planned — a live turn that has not acted yet', () => {
    const board = buildBoard([assistant([], { streaming: true })]);
    expect(at(board, 'planned')).toHaveLength(1);
    expect(at(board, 'planned')[0].title).toBe('task');
    expect(at(board, 'planned')[0].outcome).toBe('pending');
  });

  it('moves to execution as soon as the agent actually does something', () => {
    const board = buildBoard([assistant([tool('read_file')], { streaming: true })]);
    expect(at(board, 'planned')).toHaveLength(0);
    // The task card and the running tool are both in execution.
    expect(at(board, 'execution').map((c) => c.title)).toEqual(['task', 'read_file']);
  });

  it('parks a call in ready while the operator is being asked', () => {
    // A tool waiting on the permission gate is indistinguishable from a
    // running one unless the pending approval says so — which is exactly what
    // "ready to execute" means: prepared, not yet authorised.
    const board = buildBoard(
      [assistant([tool('run_shell', { input: { command: 'rm -rf build' } })], { streaming: true })],
      'run_shell',
    );
    expect(at(board, 'ready')).toHaveLength(1);
    expect(at(board, 'ready')[0].detail).toBe('rm -rf build');
    expect(at(board, 'ready')[0].outcome).toBe('pending');
    expect(at(board, 'execution').map((c) => c.title)).toEqual(['task']);
  });

  it('leaves ready empty rather than guessing when no approval is pending', () => {
    const board = buildBoard([assistant([tool('run_shell')], { streaming: true })]);
    expect(at(board, 'ready')).toHaveLength(0);
  });

  it('only holds back the call actually being asked about', () => {
    const board = buildBoard(
      [assistant([tool('read_file'), tool('run_shell')], { streaming: true })],
      'run_shell',
    );
    expect(at(board, 'ready').map((c) => c.title)).toEqual(['run_shell']);
    expect(at(board, 'execution').map((c) => c.title)).toEqual(['task', 'read_file']);
  });

  it('lands in result when the call returns, with its timing', () => {
    const board = buildBoard([assistant([tool('read_file', { result: 'ok', elapsedMs: 42 })])]);
    const card = at(board, 'result').find((c) => c.title === 'read_file')!;
    expect(card.outcome).toBe('done');
    expect(card.elapsedMs).toBe(42);
  });

  it('turns the task card into the answer once the turn completes', () => {
    const board = buildBoard([assistant([], { text: 'Done.\nDetails follow.' })]);
    const card = at(board, 'result')[0];
    expect(card.title).toBe('answer');
    expect(card.detail).toBe('Done.');
    expect(card.isTask).toBe(true);
  });
});

describe('the ways work ends', () => {
  it('shows a blocked call as blocked, not as failed', () => {
    // A denied approval is the safety system working, and reads differently
    // from a tool that broke.
    const board = buildBoard([assistant([tool('run_shell', { blocked: 'denied by operator' })])]);
    expect(at(board, 'result')[1].outcome).toBe('blocked');
  });

  it('does not leave a card executing forever after the turn ended', () => {
    // No result and no live turn means the call never finished. Painting it as
    // still running would be a lie the board never gets around to correcting.
    const board = buildBoard([assistant([tool('run_shell')], { streaming: false })]);
    expect(at(board, 'execution')).toHaveLength(0);
    expect(at(board, 'result').find((c) => c.title === 'run_shell')!.outcome).toBe('failed');
  });

  it('reports an errored turn rather than hiding it', () => {
    const board = buildBoard([assistant([], { error: 'provider timed out' })]);
    const card = at(board, 'result')[0];
    expect(card.title).toBe('error');
    expect(card.outcome).toBe('failed');
    expect(card.detail).toBe('provider timed out');
  });
});

describe('bookkeeping', () => {
  it('numbers turns so cards can be traced back to one', () => {
    const board = buildBoard([
      assistant([tool('read_file', { result: 'ok' })]),
      { id: 'u', role: 'user', text: 'again', tools: [], at: 0 },
      assistant([tool('edit_file', { result: 'ok' })]),
    ]);
    const done = at(board, 'result');
    expect(done.find((c) => c.title === 'read_file')!.turn).toBe(1);
    // The user message between them must not consume a turn number.
    expect(done.find((c) => c.title === 'edit_file')!.turn).toBe(2);
  });

  it('gives every card a distinct id, including repeats of one tool', () => {
    const board = buildBoard([assistant([
      tool('read_file', { result: 'a', input: { path: 'a.ts' } }),
      tool('read_file', { result: 'b', input: { path: 'b.ts' } }),
    ])]);
    const ids = board.columns.flatMap((c) => c.cards).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is pure — the same messages give the same board', () => {
    const messages = [assistant([tool('read_file', { result: 'ok' })], { text: 'hi' })];
    expect(buildBoard(messages)).toEqual(buildBoard(messages));
  });
});
