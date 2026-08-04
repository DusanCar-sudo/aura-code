import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// vi.hoisted() so TEST_TMP exists before the hoisted vi.mock() below runs —
// same pattern as tests/telegram-safety.test.ts (os.homedir() is read at
// module scope in unified-memory.ts).
const TEST_TMP = vi.hoisted(() => `/tmp/aura-unified-memory-test-${Date.now()}`);

vi.mock('os', async () => {
  const actual = await vi.importActual('os');
  return { ...(actual as any), homedir: () => TEST_TMP };
});

import { loadUnifiedMemory, IDENTITY_FILE } from '../src/agent/unified-memory.js';

function writeIdentity(entries: Record<string, { value: string; updated?: string }>) {
  fs.mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(entries), 'utf8');
}

describe('loadUnifiedMemory — identity ordering under truncation', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_TMP)) fs.rmSync(TEST_TMP, { recursive: true, force: true });
    fs.mkdirSync(TEST_TMP, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(TEST_TMP, { recursive: true, force: true });
  });

  it('returns empty string when there is no identity/lessons data', () => {
    expect(loadUnifiedMemory()).toBe('');
  });

  it('includes a small identity store in full', () => {
    writeIdentity({
      creator: { value: 'Dusan', updated: '2026-06-01T00:00:00Z' },
    });
    const block = loadUnifiedMemory();
    expect(block).toContain('creator');
    expect(block).toContain('Dusan');
  });

  it('prioritizes the MOST RECENTLY updated entries when the budget is tight, not insertion order', () => {
    // Old, large entries first (as identity.json accumulates over time),
    // then a small but recent standing-rule entry added last — insertion
    // order alone would drop it once the budget filled on the old entries.
    writeIdentity({
      'old-bio-1': { value: 'x'.repeat(400), updated: '2026-06-01T00:00:00Z' },
      'old-bio-2': { value: 'x'.repeat(400), updated: '2026-06-02T00:00:00Z' },
      'old-bio-3': { value: 'x'.repeat(400), updated: '2026-06-03T00:00:00Z' },
      'repo-hygiene-projects-dir': { value: 'standing rule: keep repo root clean', updated: '2026-07-09T17:42:42Z' },
    });
    // Budget small enough that not everything fits (60% of maxChars goes to identity).
    const block = loadUnifiedMemory({ maxChars: 700 });
    expect(block).toContain('repo-hygiene-projects-dir');
    expect(block).toContain('standing rule: keep repo root clean');
  });

  it('treats a missing `updated` timestamp as oldest, not first', () => {
    // Budget fits exactly one of these two similarly-sized entries — the one
    // with no `updated` must lose to the one with a real, recent timestamp.
    writeIdentity({
      'no-timestamp': { value: 'y'.repeat(150) }, // no `updated`
      recent: { value: 'z'.repeat(150), updated: '2026-07-09T00:00:00Z' },
    });
    const block = loadUnifiedMemory({ maxChars: 300 });
    expect(block).toContain('recent');
    expect(block).not.toContain('no-timestamp');
  });

  it('still fills the budget by considering later (smaller) entries after skipping one that didn\'t fit', () => {
    writeIdentity({
      big: { value: 'x'.repeat(1000), updated: '2026-07-09T00:00:00Z' },
      small: { value: 'small fact', updated: '2026-07-08T00:00:00Z' },
    });
    // Budget too small for "big" but big enough for "small" once big is skipped.
    const block = loadUnifiedMemory({ maxChars: 100 });
    expect(block).toContain('small fact');
    expect(block).not.toContain('x'.repeat(1000));
  });
});
