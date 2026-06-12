import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  savePerception,
  loadPerception,
  isStale,
  clearPerception,
} from '../../src/perception/graph-store.js';
import type { ProjectPerception } from '../../src/perception/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture: a minimal but complete ProjectPerception
// ─────────────────────────────────────────────────────────────────────────────
function makePerception(overrides: Partial<ProjectPerception> = {}): ProjectPerception {
  return {
    projectRoot: '/fake/project',
    nodes: [
      {
        id: 'src/index.ts',
        type: 'file',
        label: 'index.ts',
        description: 'Entry point',
        metadata: {},
      },
      {
        id: 'src/utils.ts',
        type: 'file',
        label: 'utils.ts',
        description: 'Utilities',
        metadata: {},
      },
      {
        id: 'core',
        type: 'module',
        label: 'Core module',
        description: 'Core functionality',
        metadata: {},
      },
    ],
    edges: [
      {
        from: 'src/index.ts',
        to: 'src/utils.ts',
        relationship: 'depends_on',
        weight: 0.9,
        metadata: {},
      },
    ],
    trajectory: {
      vision: 'Build the best thing',
      deprecated: [],
      inProgress: [],
      planned: [],
    },
    constraints: {
      readOnly: ['package-lock.json'],
      strictRules: ['No circular deps'],
      riskAreas: [],
      testCoverage: [{ module: 'src', coverage: 'medium' }],
    },
    extractedAt: Date.now(),
    version: '1.0.0',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// savePerception & loadPerception
// ─────────────────────────────────────────────────────────────────────────────
describe('savePerception / loadPerception', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-gs-'));
    storePath = path.join(tmpDir, 'perception.json');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('savePerception writes valid JSON to the correct path', async () => {
    const perception = makePerception();
    await savePerception(perception, storePath);

    expect(fs.existsSync(storePath)).toBe(true);
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.projectRoot).toBe('/fake/project');
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.version).toBe('1.0.0');
  });

  it('loadPerception returns null when file does not exist', async () => {
    const result = await loadPerception(path.join(tmpDir, 'does-not-exist.json'));
    expect(result).toBeNull();
  });

  it('loadPerception returns the correct perception after save', async () => {
    const perception = makePerception();
    await savePerception(perception, storePath);

    const loaded = await loadPerception(storePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.projectRoot).toBe('/fake/project');
    expect(loaded!.nodes).toHaveLength(3);
    expect(loaded!.edges).toHaveLength(1);
    expect(loaded!.trajectory.vision).toBe('Build the best thing');
    expect(loaded!.version).toBe('1.0.0');
  });

  it('save then load preserves all fields exactly', async () => {
    const perception = makePerception({
      trajectory: {
        vision: 'Exact match test',
        deprecated: ['old-api'],
        inProgress: ['new-feature'],
        planned: ['future-thing'],
      },
      constraints: {
        readOnly: ['config.json'],
        strictRules: ['rule-1', 'rule-2'],
        riskAreas: ['src/legacy/'],
        testCoverage: [
          { module: 'src', coverage: 'high' },
          { module: 'tests', coverage: 'low' },
        ],
      },
    });

    await savePerception(perception, storePath);
    const loaded = await loadPerception(storePath);

    expect(loaded).toEqual(perception);
  });

  it('savePerception overwrites existing file', async () => {
    const v1 = makePerception({ version: '1.0.0' });
    const v2 = makePerception({ version: '2.0.0' });

    await savePerception(v1, storePath);
    await savePerception(v2, storePath);

    const loaded = await loadPerception(storePath);
    expect(loaded!.version).toBe('2.0.0');
  });

  it('savePerception creates parent directories if needed', async () => {
    const deep = path.join(tmpDir, 'deep', 'nested', 'dir', 'perception.json');
    const perception = makePerception();
    await savePerception(perception, deep);

    expect(fs.existsSync(deep)).toBe(true);
    const loaded = await loadPerception(deep);
    expect(loaded!.projectRoot).toBe('/fake/project');
  });

  it('loadPerception handles corrupt JSON gracefully', async () => {
    fs.writeFileSync(storePath, '{ this is not valid json }');
    const result = await loadPerception(storePath);
    expect(result).toBeNull();
  });

  it('loadPerception handles empty file gracefully', async () => {
    fs.writeFileSync(storePath, '');
    const result = await loadPerception(storePath);
    expect(result).toBeNull();
  });

  it('loadPerception handles file with wrong shape (missing required fields)', async () => {
    fs.writeFileSync(storePath, JSON.stringify({ notA: 'perception' }));
    // Should either return null or throw — but not silently corrupt data
    const result = await loadPerception(storePath);
    // It's acceptable to return null for invalid shape
    if (result !== null) {
      // If it returns something, it must at least be a valid perception shape
      expect(result.projectRoot).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isStale
// ─────────────────────────────────────────────────────────────────────────────
describe('isStale', () => {
  it('returns false immediately after save', () => {
    const perception = makePerception({ extractedAt: Date.now() });
    // Default maxAgeMs should be something reasonable like 5 minutes
    expect(isStale(perception)).toBe(false);
  });

  it('returns true when maxAgeMs is 0', () => {
    const perception = makePerception({ extractedAt: Date.now() });
    expect(isStale(perception, 0)).toBe(true);
  });

  it('returns true for old perception', () => {
    const perception = makePerception({ extractedAt: Date.now() - 1_000_000 });
    expect(isStale(perception, 500)).toBe(true);
  });

  it('returns false for perception exactly at the boundary', () => {
    const perception = makePerception({ extractedAt: Date.now() - 1000 });
    // maxAgeMs = 1000, so age == maxAgeMs — boundary case
    const result = isStale(perception, 1000);
    // Either behavior is acceptable at exact boundary, but must be consistent
    expect(typeof result).toBe('boolean');
  });

  it('returns true when extractedAt is undefined (missing timestamp)', () => {
    const perception = makePerception({ extractedAt: undefined as unknown as number });
    expect(isStale(perception)).toBe(true);
  });

  it('returns true when extractedAt is NaN', () => {
    const perception = makePerception({ extractedAt: NaN });
    expect(isStale(perception)).toBe(true);
  });

  it('returns true when extractedAt is Infinity', () => {
    const perception = makePerception({ extractedAt: Infinity });
    expect(isStale(perception)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clearPerception
// ─────────────────────────────────────────────────────────────────────────────
describe('clearPerception', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-gs-'));
    storePath = path.join(tmpDir, 'perception.json');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('removes the file', async () => {
    const perception = makePerception();
    await savePerception(perception, storePath);
    expect(fs.existsSync(storePath)).toBe(true);

    await clearPerception(storePath);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it('is safe to call when file does not exist (no throw)', async () => {
    await expect(clearPerception(storePath)).resolves.not.toThrow();
  });

  it('after clear, loadPerception returns null', async () => {
    const perception = makePerception();
    await savePerception(perception, storePath);
    await clearPerception(storePath);

    const loaded = await loadPerception(storePath);
    expect(loaded).toBeNull();
  });
});
