import { describe, it, expect } from 'vitest';
import { tasksIn, BOARD_COLUMNS, type BoardTask } from '../../web/src/hooks/useBoard.js';

/**
 * The client's share of the board is deliberately thin — the engine owns the
 * tasks and every mutation is a round trip, so there is little here to test
 * beyond the one thing the client decides on its own: what order tiles appear
 * in. Ordering is worth pinning because it is the part a user would notice
 * immediately and could not explain.
 */

const task = (over: Partial<BoardTask> & { id: string }): BoardTask => ({
  title: over.id, column: 'planning', agent: 'aura', order: 0,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('the four columns', () => {
  it('are the flow, in order', () => {
    expect([...BOARD_COLUMNS]).toEqual(['planning', 'preparation', 'execution', 'finished']);
  });
});

describe('tile ordering', () => {
  it('sorts by order within a column', () => {
    const tasks = [
      task({ id: 'c', order: 3000 }),
      task({ id: 'a', order: 1000 }),
      task({ id: 'b', order: 2000 }),
    ];
    expect(tasksIn(tasks, 'planning').map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to creation time when orders tie', () => {
    // Two tiles can share an order after a hand-edited file or a race; the
    // board must still render them in a stable, explainable sequence rather
    // than whatever the array happened to hold.
    const tasks = [
      task({ id: 'later', order: 1000, createdAt: '2026-02-01T00:00:00.000Z' }),
      task({ id: 'earlier', order: 1000, createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(tasksIn(tasks, 'planning').map((t) => t.id)).toEqual(['earlier', 'later']);
  });

  it('keeps each column to its own tiles', () => {
    const tasks = [
      task({ id: 'plan' }),
      task({ id: 'run', column: 'execution' }),
      task({ id: 'done', column: 'finished' }),
    ];
    expect(tasksIn(tasks, 'execution').map((t) => t.id)).toEqual(['run']);
    expect(tasksIn(tasks, 'preparation')).toEqual([]);
  });
});
