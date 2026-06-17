import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  episodeStore,
  saveEpisode,
  loadEpisodes,
  deleteEpisode,
  getEpisodeStats,
  estimateTokens,
} from '../../src/ruby/episode-capture.js';
import type { Episode } from '../../src/ruby/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a minimal Episode with a stable id unless overridden. */
let epCounter = 0;
function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  epCounter++;
  return {
    id: overrides.id ?? `ep-${epCounter}`,
    timestamp: overrides.timestamp ?? Date.now(),
    task: 'Fix the auth bug in core/auth.ts',
    projectRoot: '/fake/project',
    rubyAttempted: true,
    rubySucceeded: overrides.rubySucceeded ?? true,
    reviewerApproved: true,
    tokensUsed: { ruby: 100 },
    durationMs: 5000,
    taskCategory: 'implementation',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// saveEpisode & loadEpisodes
// ─────────────────────────────────────────────────────────────────────────────
describe('saveEpisode & loadEpisodes', () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-ruby-'));
    vi.stubEnv('HOME', tmpDir);
    projectRoot = path.join(tmpDir, 'fake-project');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    epCounter = 0;
  });

  it('save then load returns the same episode', async () => {
    const episode = makeEpisode({
      id: 'ep-save-load',
      timestamp: 1_700_000_000_000,
      task: 'Add rate limiting',
      rubyAttempted: true,
      rubySucceeded: true,
      reviewerApproved: true,
      tokensUsed: { ruby: 250 },
      durationMs: 8000,
    });

    await saveEpisode(projectRoot, episode);
    const loaded = await loadEpisodes(projectRoot);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(episode);
  });

  it('loadEpisodes returns empty array when no episodes exist', async () => {
    const loaded = await loadEpisodes(projectRoot);
    expect(loaded).toEqual([]);
  });

  it('loadEpisodes returns empty array when directory does not exist', async () => {
    const loaded = await loadEpisodes(path.join(tmpDir, 'nonexistent-project'));
    expect(loaded).toEqual([]);
  });

  it('never throws on missing directory', async () => {
    await expect(loadEpisodes(path.join(tmpDir, 'definitely-not-a-real-dir'))).resolves
      .toBeDefined();
  });

  it('loadEpisodes respects limit parameter', async () => {
    // Save 5 episodes with different timestamps
    for (let i = 0; i < 5; i++) {
      await saveEpisode(projectRoot, makeEpisode({
        id: `ep-limited-${i}`,
        timestamp: 1_000 + i * 100, // ascending timestamps
      }));
    }

    const all = await loadEpisodes(projectRoot);
    expect(all).toHaveLength(5);

    const limited = await loadEpisodes(projectRoot, 2);
    expect(limited).toHaveLength(2);

    // Newest first — should be the last two created
    expect(limited[0].id).toBe('ep-limited-4'); // timestamp 1400 (newest)
    expect(limited[1].id).toBe('ep-limited-3'); // timestamp 1300
  });

  it('loadEpisodes sorts by timestamp descending (newest first)', async () => {
    const old = makeEpisode({ id: 'ep-old', timestamp: 1_000_000 });
    const mid = makeEpisode({ id: 'ep-mid', timestamp: 2_000_000 });
    const newer = makeEpisode({ id: 'ep-new', timestamp: 3_000_000 });

    // Save in arbitrary order
    await saveEpisode(projectRoot, mid);
    await saveEpisode(projectRoot, old);
    await saveEpisode(projectRoot, newer);

    const loaded = await loadEpisodes(projectRoot);
    expect(loaded).toHaveLength(3);
    expect(loaded[0].id).toBe('ep-new');
    expect(loaded[1].id).toBe('ep-mid');
    expect(loaded[2].id).toBe('ep-old');
  });

  it('saveEpisode creates the project directory if needed', async () => {
    const episode = makeEpisode();
    await saveEpisode(projectRoot, episode);

    const projDir = episodeStore.projectDir(projectRoot);
    expect(fs.existsSync(projDir)).toBe(true);

    const epPath = episodeStore.episodePath(projectRoot, episode.id);
    expect(fs.existsSync(epPath)).toBe(true);
  });

  it('saveEpisode writes valid JSON atomically (no .tmp leftover)', async () => {
    const episode = makeEpisode({ id: 'ep-atomic' });
    await saveEpisode(projectRoot, episode);

    const projDir = episodeStore.projectDir(projectRoot);
    const files = fs.readdirSync(projDir);
    // Should have .json file but no .tmp leftover
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false);
    expect(files.some(f => f.endsWith('.json'))).toBe(true);

    const raw = fs.readFileSync(
      episodeStore.episodePath(projectRoot, 'ep-atomic'),
      'utf8',
    );
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe('ep-atomic');
    expect(parsed.task).toBe(episode.task);
  });

  it('saveEpisode overwrites an existing episode with the same id', async () => {
    const v1 = makeEpisode({ id: 'ep-overwrite', task: 'Original task', timestamp: 1000 });
    await saveEpisode(projectRoot, v1);

    const v2 = makeEpisode({ id: 'ep-overwrite', task: 'Updated task', timestamp: 2000 });
    await saveEpisode(projectRoot, v2);

    const loaded = await loadEpisodes(projectRoot);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('ep-overwrite');
    expect(loaded[0].task).toBe('Updated task');
  });

  it('loadEpisodes skips corrupt JSON files', async () => {
    // Write a valid episode
    await saveEpisode(projectRoot, makeEpisode({ id: 'ep-valid-1' }));

    // Write a corrupt file directly
    const projDir = episodeStore.projectDir(projectRoot);
    if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'corrupt.json'), '{ this is not valid json }');

    // Write another valid episode
    await saveEpisode(projectRoot, makeEpisode({ id: 'ep-valid-2' }));

    const loaded = await loadEpisodes(projectRoot);
    expect(loaded).toHaveLength(2);
    expect(loaded.map(e => e.id).sort()).toEqual(['ep-valid-1', 'ep-valid-2']);
  });

  it('loadEpisodes skips files without required fields', async () => {
    await saveEpisode(projectRoot, makeEpisode({ id: 'ep-ok' }));

    // Write a JSON file that's valid JSON but missing id/timestamp
    const projDir = episodeStore.projectDir(projectRoot);
    if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'bad-shape.json'), JSON.stringify({ foo: 'bar' }));

    const loaded = await loadEpisodes(projectRoot);
    // The malformed one should be skipped
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('ep-ok');
  });

  it('loadEpisodes is safe when directory contains non-JSON files', async () => {
    const projDir = episodeStore.projectDir(projectRoot);
    if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'notes.txt'), 'Just some notes, not an episode');

    const loaded = await loadEpisodes(projectRoot);
    expect(loaded).toEqual([]);
  });

  it('both episodeStore.loadEpisodes and named loadEpisodes work identically', async () => {
    const episode = makeEpisode({ id: 'ep-named-test' });
    await episodeStore.saveEpisode(projectRoot, episode);

    const viaObject = await episodeStore.loadEpisodes(projectRoot);
    const viaNamed = await loadEpisodes(projectRoot);

    expect(viaObject).toEqual(viaNamed);
    expect(viaObject).toHaveLength(1);
    expect(viaObject[0].id).toBe('ep-named-test');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getEpisodeStats
// ─────────────────────────────────────────────────────────────────────────────
describe('getEpisodeStats', () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-ruby-'));
    vi.stubEnv('HOME', tmpDir);
    projectRoot = path.join(tmpDir, 'fake-project');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    epCounter = 0;
  });

  it('returns zeros for empty project', async () => {
    const stats = await getEpisodeStats(projectRoot);

    expect(stats.total).toBe(0);
    expect(stats.rubySuccesses).toBe(0);
    expect(stats.rubyFailures).toBe(0);
    expect(stats.largeModelInterventions).toBe(0);
    expect(stats.readyForFineTune).toBe(false);
  });

  it('returns zeros for missing directory', async () => {
    const stats = await getEpisodeStats(path.join(tmpDir, 'nonexistent-project'));
    expect(stats.total).toBe(0);
    expect(stats.rubySuccesses).toBe(0);
    expect(stats.rubyFailures).toBe(0);
    expect(stats.readyForFineTune).toBe(false);
  });

  it('counts rubySuccesses correctly', async () => {
    await saveEpisode(projectRoot, makeEpisode({
      id: 'ep-s-1', rubyAttempted: true, rubySucceeded: true,
    }));
    await saveEpisode(projectRoot, makeEpisode({
      id: 'ep-s-2', rubyAttempted: true, rubySucceeded: true,
    }));
    await saveEpisode(projectRoot, makeEpisode({
      id: 'ep-s-3', rubyAttempted: true, rubySucceeded: false,
    }));

    const stats = await getEpisodeStats(projectRoot);
    expect(stats.total).toBe(3);
    expect(stats.rubySuccesses).toBe(2);
    expect(stats.rubyFailures).toBe(1);
  });

  it('counts rubyFailures correctly', async () => {
    await saveEpisode(projectRoot, makeEpisode({
      id: 'ep-f-1', rubyAttempted: true, rubySucceeded: false,
    }));
    await saveEpisode(projectRoot, makeEpisode({
      id: 'ep-f-2', rubyAttempted: true, rubySucceeded: false,
    }));

    const stats = await getEpisodeStats(projectRoot);
    expect(stats.rubyFailures).toBe(2);
    expect(stats.rubySuccesses).toBe(0);
  });

  it('counts largeModelInterventions when largeModelUsed is set', async () => {
    await saveEpisode(projectRoot, makeEpisode({
      id: 'ep-lm-1', largeModelUsed: 'claude-sonnet-4-5-20251001',
    }));
    await saveEpisode(projectRoot, makeEpisode({
      id: 'ep-lm-2', largeModelUsed: 'gpt-4o',
    }));
    await saveEpisode(projectRoot, makeEpisode({
      id: 'ep-lm-3',
      // largeModelUsed not set (Ruby succeeded, no large model needed)
    }));

    const stats = await getEpisodeStats(projectRoot);
    expect(stats.largeModelInterventions).toBe(2);
  });

  it('readyForFineTune is false when not enough failures', async () => {
    // 10 failures — less than DEFAULT_MIN_FAILURES (20)
    for (let i = 0; i < 10; i++) {
      await saveEpisode(projectRoot, makeEpisode({
        id: `ep-ft-no-${i}`,
        rubyAttempted: true,
        rubySucceeded: false,
      }));
    }
    const stats = await getEpisodeStats(projectRoot);
    expect(stats.rubyFailures).toBe(10);
    expect(stats.readyForFineTune).toBe(false);
  });

  it('readyForFineTune is true when enough failures accumulate', async () => {
    // Exactly 20 failures
    for (let i = 0; i < 20; i++) {
      await saveEpisode(projectRoot, makeEpisode({
        id: `ep-ft-yes-${i}`,
        rubyAttempted: true,
        rubySucceeded: false,
      }));
    }
    const stats = await getEpisodeStats(projectRoot);
    expect(stats.rubyFailures).toBe(20);
    expect(stats.readyForFineTune).toBe(true);
  });

  it('readyForFineTune is true when failures exceed threshold', async () => {
    // 30 failures
    for (let i = 0; i < 30; i++) {
      await saveEpisode(projectRoot, makeEpisode({
        id: `ep-ft-exceed-${i}`,
        rubyAttempted: true,
        rubySucceeded: false,
      }));
    }
    const stats = await getEpisodeStats(projectRoot);
    expect(stats.readyForFineTune).toBe(true);
  });

  it('readyForFineTune uses only rubyAttempted + not rubySucceeded', async () => {
    // 15 failures + 10 successes = 15 failures counted (< 20 → false)
    for (let i = 0; i < 15; i++) {
      await saveEpisode(projectRoot, makeEpisode({
        id: `ep-mixed-fail-${i}`, rubyAttempted: true, rubySucceeded: false,
      }));
    }
    for (let i = 0; i < 10; i++) {
      await saveEpisode(projectRoot, makeEpisode({
        id: `ep-mixed-succ-${i}`, rubyAttempted: true, rubySucceeded: true,
      }));
    }
    const stats = await getEpisodeStats(projectRoot);
    expect(stats.rubyFailures).toBe(15);
    expect(stats.rubySuccesses).toBe(10);
    expect(stats.readyForFineTune).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteEpisode
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteEpisode', () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-ruby-'));
    vi.stubEnv('HOME', tmpDir);
    projectRoot = path.join(tmpDir, 'fake-project');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    epCounter = 0;
  });

  it('removes the file', async () => {
    const episode = makeEpisode({ id: 'ep-to-delete' });
    await saveEpisode(projectRoot, episode);

    const epPath = episodeStore.episodePath(projectRoot, 'ep-to-delete');
    expect(fs.existsSync(epPath)).toBe(true);

    await deleteEpisode(projectRoot, 'ep-to-delete');
    expect(fs.existsSync(epPath)).toBe(false);
  });

  it('is safe to call when file does not exist (no throw)', async () => {
    await expect(deleteEpisode(projectRoot, 'does-not-exist')).resolves.toBeUndefined();
  });

  it('is safe to call when project directory does not exist', async () => {
    const nonExistent = path.join(tmpDir, 'never-created-project');
    await expect(deleteEpisode(nonExistent, 'any-id')).resolves.toBeUndefined();
  });

  it('after delete, loadEpisodes no longer includes that episode', async () => {
    await saveEpisode(projectRoot, makeEpisode({ id: 'ep-keep' }));
    await saveEpisode(projectRoot, makeEpisode({ id: 'ep-remove' }));

    await deleteEpisode(projectRoot, 'ep-remove');

    const loaded = await loadEpisodes(projectRoot);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('ep-keep');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// projectHash determinism
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// estimateTokens
// ─────────────────────────────────────────────────────────────────────────────
describe('estimateTokens', () => {
  it('returns 0 for undefined', () => {
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates roughly 1 token per 4 characters', () => {
    // 100 chars → ceil(100/4) = 25
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });

  it('rounds up', () => {
    // 5 chars → ceil(5/4) = 2
    expect(estimateTokens('hello')).toBe(2);
  });

  it('handles typical model output', () => {
    const output = 'I have updated the file src/auth.ts to fix the authentication bug.';
    const est = estimateTokens(output);
    expect(est).toBeGreaterThan(5);
    expect(est).toBeLessThan(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// saveEpisode — token estimation fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('saveEpisode — token estimation fallback', () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-ruby-est-'));
    vi.stubEnv('HOME', tmpDir);
    projectRoot = path.join(tmpDir, 'fake-project');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fills estimated ruby tokens when rubyAttempted and tokensUsed.ruby is 0', async () => {
    const episode: Episode = {
      id: 'est-ruby-0',
      timestamp: Date.now(),
      task: 'Fix bug',
      projectRoot,
      rubyAttempted: true,
      rubySucceeded: false,
      rubyOutput: 'I tried to fix the bug but failed. The error is in line 42 of main.ts.',
      reviewerApproved: false,
      tokensUsed: { ruby: 0 },
      durationMs: 1000,
      taskCategory: 'other',
    };

    await saveEpisode(projectRoot, episode);
    const loaded = await loadEpisodes(projectRoot);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].tokensUsed.ruby).toBeGreaterThan(0);
    expect(loaded[0].tokensUsed.ruby).toBe(estimateTokens(episode.rubyOutput));
  });

  it('fills estimated largeModel tokens when largeModelUsed and tokensUsed.largeModel is 0', async () => {
    const output = 'Here is the fixed code. I updated the auth handler to validate tokens correctly.';
    const episode: Episode = {
      id: 'est-large-0',
      timestamp: Date.now(),
      task: 'Fix auth',
      projectRoot,
      rubyAttempted: false,
      rubySucceeded: false,
      largeModelUsed: 'mimo-v2.5-pro',
      largeModelOutput: output,
      reviewerApproved: true,
      tokensUsed: { largeModel: 0 },
      durationMs: 2000,
      taskCategory: 'other',
    };

    await saveEpisode(projectRoot, episode);
    const loaded = await loadEpisodes(projectRoot);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].tokensUsed.largeModel).toBeGreaterThan(0);
    expect(loaded[0].tokensUsed.largeModel).toBe(estimateTokens(output));
  });

  it('does NOT overwrite tokens when the provider already reported them', async () => {
    const episode: Episode = {
      id: 'est-keep',
      timestamp: Date.now(),
      task: 'Fix bug',
      projectRoot,
      rubyAttempted: true,
      rubySucceeded: true,
      rubyOutput: 'Fixed the bug in auth.ts',
      reviewerApproved: true,
      tokensUsed: { ruby: 500 },
      durationMs: 1000,
      taskCategory: 'other',
    };

    await saveEpisode(projectRoot, episode);
    const loaded = await loadEpisodes(projectRoot);

    expect(loaded[0].tokensUsed.ruby).toBe(500); // original, not estimated
  });

  it('estimates both ruby and largeModel when both are 0', async () => {
    const rubyOutput = 'Ruby tried but produced incomplete output.';
    const largeOutput = 'The large model fixed the remaining issues in the auth module.';
    const episode: Episode = {
      id: 'est-both',
      timestamp: Date.now(),
      task: 'Fix auth',
      projectRoot,
      rubyAttempted: true,
      rubySucceeded: false,
      rubyOutput,
      largeModelUsed: 'mimo-v2.5-pro',
      largeModelOutput: largeOutput,
      reviewerApproved: true,
      tokensUsed: { ruby: 0, largeModel: 0 },
      durationMs: 3000,
      taskCategory: 'other',
    };

    await saveEpisode(projectRoot, episode);
    const loaded = await loadEpisodes(projectRoot);

    expect(loaded[0].tokensUsed.ruby).toBe(estimateTokens(rubyOutput));
    expect(loaded[0].tokensUsed.largeModel).toBe(estimateTokens(largeOutput));
  });

  it('does not estimate when rubyOutput is undefined and ruby tokens are 0', async () => {
    const episode: Episode = {
      id: 'est-no-output',
      timestamp: Date.now(),
      task: 'Fix bug',
      projectRoot,
      rubyAttempted: true,
      rubySucceeded: false,
      // no rubyOutput
      reviewerApproved: false,
      tokensUsed: { ruby: 0 },
      durationMs: 1000,
      taskCategory: 'other',
    };

    await saveEpisode(projectRoot, episode);
    const loaded = await loadEpisodes(projectRoot);

    // Should remain 0 since there's no output text to estimate from
    expect(loaded[0].tokensUsed.ruby).toBe(0);
  });
});

describe('episodeStore — projectHash', () => {
  it('produces the same hash for the same projectRoot', () => {
    const h1 = episodeStore.projectHash('/home/user/my-project');
    const h2 = episodeStore.projectHash('/home/user/my-project');
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different projectRoots', () => {
    const h1 = episodeStore.projectHash('/projects/my-app');
    const h2 = episodeStore.projectHash('/opt/other-app');
    // Short base64 is prefix-sensitive; these paths differ early enough
    expect(h1).not.toBe(h2);
  });

  it('hash is exactly 8 characters', () => {
    const h = episodeStore.projectHash('/any/project/root');
    expect(h.length).toBe(8);
  });
});
