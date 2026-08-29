import { describe, it, expect } from 'vitest';
import { addTask, orderBetween, tasksIn, updateTask } from '../../src/board/store.js';
import type { BoardState } from '../../src/board/types.js';

const empty = (): BoardState => ({ version: 1, tasks: [] });

describe('ordering within a column', () => {
  it('keeps the operator\'s arrangement in the first three columns', () => {
    // Where something sits in a plan is a judgement, and the board keeps it.
    const s = empty();
    const a = addTask(s, { title: 'a' });
    const b = addTask(s, { title: 'b' });
    updateTask(s, b.id, { order: a.order - 500 });
    expect(tasksIn(s, 'planning').map((t) => t.title)).toEqual(['b', 'a']);
  });

  it('orders finished by when things finished, not by arrangement', () => {
    // Finished is a record of what happened. The order it happened in is not
    // the operator's to rearrange, so dragging within it does nothing.
    const s = empty();
    const first = addTask(s, { title: 'first', column: 'finished' });
    const second = addTask(s, { title: 'second', column: 'finished' });
    // Give 'second' a lower order — in any other column that would move it up.
    second.order = first.order - 5000;
    first.updatedAt = '2026-01-01T00:00:00.000Z';
    second.updatedAt = '2026-01-02T00:00:00.000Z';
    expect(tasksIn(s, 'finished').map((t) => t.title)).toEqual(['first', 'second']);
  });

  it('finds a slot between two neighbours without renumbering them', () => {
    const s = empty();
    const a = addTask(s, { title: 'a' });
    const b = addTask(s, { title: 'b' });
    const mid = orderBetween(a, b);
    expect(mid).toBeGreaterThan(a.order);
    expect(mid).toBeLessThan(b.order);
  });

  it('handles the ends of a column', () => {
    const s = empty();
    const only = addTask(s, { title: 'only' });
    expect(orderBetween(undefined, only)).toBeLessThan(only.order);
    expect(orderBetween(only, undefined)).toBeGreaterThan(only.order);
    expect(orderBetween(undefined, undefined)).toBe(1000);
  });
});

describe('urgency and attention', () => {
  it('are set by the operator, and are separate things', () => {
    // "It needs you" and "it went wrong" ask for different responses; a board
    // that renders them the same teaches people to ignore both.
    const s = empty();
    const t = addTask(s, { title: 'x' });
    updateTask(s, t.id, { priority: 'urgent', attention: true });
    expect(s.tasks[0].priority).toBe('urgent');
    expect(s.tasks[0].attention).toBe(true);
    expect(s.tasks[0].failed).toBeUndefined();
  });
});

describe('the workflow connector', () => {
  it('links one task to the next', () => {
    const s = empty();
    const a = addTask(s, { title: 'first', column: 'preparation' });
    const b = addTask(s, { title: 'then this' });
    updateTask(s, a.id, { linkedTo: b.id });
    expect(s.tasks[0].linkedTo).toBe(b.id);
  });

  it('clears the link on an empty string', () => {
    const s = empty();
    const a = addTask(s, { title: 'a' });
    const b = addTask(s, { title: 'b' });
    updateTask(s, a.id, { linkedTo: b.id });
    updateTask(s, a.id, { linkedTo: '' });
    expect(s.tasks[0].linkedTo).toBeUndefined();
  });
});

describe('the fields a client is allowed to set', () => {
  it('covers every field TaskPatch declares', async () => {
    // An allowlist keeps the wire from reaching anything the board did not
    // mean to expose. The cost is that a field added to the model and
    // forgotten in the handler is dropped in silence — which is exactly what
    // happened to priority, attention and linkedTo: the UI wrote them, the
    // engine ignored them, and nothing anywhere said so.
    const fs = await import('fs');
    const src = fs.readFileSync('src/protocol/handler.ts', 'utf8');
    const listed = /for \(const key of \[([\s\S]*?)\]\)/.exec(src)?.[1] ?? '';
    const allowed = new Set([...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]));

    const storeSrc = fs.readFileSync('src/board/store.ts', 'utf8');
    const patch = /export interface TaskPatch \{([\s\S]*?)\n\}/.exec(storeSrc)?.[1] ?? '';
    const fields = [...patch.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);

    expect(fields.length).toBeGreaterThan(5);
    // attachments is set through the upload route, not over the socket.
    const missing = fields.filter((f) => f !== 'attachments' && !allowed.has(f));
    expect(missing).toEqual([]);
  });
});
