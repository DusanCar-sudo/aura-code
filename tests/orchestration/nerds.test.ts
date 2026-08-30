import { afterEach, describe, expect, it } from 'vitest';

import { NerdsPolicy } from '../../src/orchestration/nerds.js';

afterEach(() => NerdsPolicy.reset());

describe('nerds — one writer at a time', () => {
  it('is off until enabled, and lets everyone write', async () => {
    await NerdsPolicy.acquireWriter('a');
    // No await needed: with the policy off this must not block.
    await NerdsPolicy.acquireWriter('b');
    expect(NerdsPolicy.getState().enabled).toBe(false);
  });

  it('grants the first writer and queues the second', async () => {
    NerdsPolicy.enable();
    await NerdsPolicy.acquireWriter('a');

    let bGotIt = false;
    void NerdsPolicy.acquireWriter('b').then(() => { bGotIt = true; });
    await Promise.resolve();

    expect(bGotIt).toBe(false);
    expect(NerdsPolicy.getState()).toEqual({ enabled: true, holder: 'a', waiting: ['b'] });
  });

  it('hands the lease to the next in line on release', async () => {
    NerdsPolicy.enable();
    await NerdsPolicy.acquireWriter('a');
    const b = NerdsPolicy.acquireWriter('b');

    NerdsPolicy.releaseWriter('a');
    await b;

    expect(NerdsPolicy.getState().holder).toBe('b');
    expect(NerdsPolicy.getState().waiting).toEqual([]);
  });

  it('keeps arrival order across several waiters', async () => {
    NerdsPolicy.enable();
    await NerdsPolicy.acquireWriter('a');
    const order: string[] = [];
    const b = NerdsPolicy.acquireWriter('b').then(() => { order.push('b'); });
    const c = NerdsPolicy.acquireWriter('c').then(() => { order.push('c'); });

    NerdsPolicy.releaseWriter('a');
    await b;
    NerdsPolicy.releaseWriter('b');
    await c;

    expect(order).toEqual(['b', 'c']);
  });

  it('is re-entrant for the holder', async () => {
    NerdsPolicy.enable();
    await NerdsPolicy.acquireWriter('a');
    // Would deadlock if the holder queued behind itself.
    await NerdsPolicy.acquireWriter('a');
    expect(NerdsPolicy.getState().holder).toBe('a');
  });

  it('ignores a release from a task that does not hold the lease', async () => {
    NerdsPolicy.enable();
    await NerdsPolicy.acquireWriter('a');
    // A cancelled task releasing twice must not eject the current holder.
    NerdsPolicy.releaseWriter('someone-else');
    expect(NerdsPolicy.getState().holder).toBe('a');
  });

  it('reports whether a task would wait, without queueing it', async () => {
    NerdsPolicy.enable();
    await NerdsPolicy.acquireWriter('a');

    expect(NerdsPolicy.inspect('a')).toEqual({ granted: true, position: 0 });
    expect(NerdsPolicy.inspect('b')).toEqual({ granted: false, position: 1 });
    // Inspecting must not have enrolled 'b'.
    expect(NerdsPolicy.getState().waiting).toEqual([]);
  });

  it('releases every waiter when disabled, rather than stranding them', async () => {
    NerdsPolicy.enable();
    await NerdsPolicy.acquireWriter('a');
    const b = NerdsPolicy.acquireWriter('b');
    const c = NerdsPolicy.acquireWriter('c');

    NerdsPolicy.disable();

    // Both resolve; leaving them pending would hang the tasks instead of
    // freeing them.
    await expect(Promise.all([b, c])).resolves.toBeDefined();
    expect(NerdsPolicy.getState()).toEqual({ enabled: false, holder: null, waiting: [] });
  });
});
