import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createBlueprint,
  loadBlueprint,
  saveBlueprint,
  listBlueprints,
  markBuilt,
  addDeviation,
  updateBlueprintStatus,
  blueprintsDir,
} from '../../src/architect/engine.js';
import type { Blueprint, BlueprintFile, BlueprintDataModel } from '../../src/architect/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeFile(overrides: Partial<BlueprintFile> = {}): BlueprintFile {
  return {
    path: 'src/example.ts',
    purpose: 'Example file for testing',
    exports: ['ExampleClass'],
    interfaces: ['ExampleInterface'],
    status: 'planned',
    ...overrides,
  };
}

function makeDataModel(overrides: Partial<BlueprintDataModel> = {}): BlueprintDataModel {
  return {
    name: 'TestModel',
    fields: ['id: string', 'name: string'],
    description: 'A test data model',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Isolated temp directory for each test
// ─────────────────────────────────────────────────────────────────────────────
let homeTmp: string;

beforeEach(() => {
  homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-blueprints-'));
  vi.stubEnv('HOME', homeTmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(homeTmp, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// blueprintsDir
// ─────────────────────────────────────────────────────────────────────────────
describe('blueprintsDir()', () => {
  it('returns ~/.rubycode/blueprints by default', () => {
    expect(blueprintsDir()).toBe(path.join(homeTmp, '.rubycode', 'blueprints'));
  });

  it('respects RUBY_BLUEPRINT_DIR env var', () => {
    vi.stubEnv('RUBY_BLUEPRINT_DIR', '/custom/blueprints');
    expect(blueprintsDir()).toBe('/custom/blueprints');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createBlueprint
// ─────────────────────────────────────────────────────────────────────────────
describe('createBlueprint()', () => {
  it('creates a blueprint with correct id, task, and defaults', async () => {
    const bp = await createBlueprint('Add auth module', '/project');

    expect(bp.id).toBeTruthy();
    expect(bp.task).toBe('Add auth module');
    expect(bp.createdAt).toBeGreaterThan(0);
    expect(bp.status).toBe('draft');
    expect(bp.files).toHaveLength(0);
    expect(bp.dataModels).toHaveLength(0);
    expect(bp.dependencies).toHaveLength(0);
    expect(bp.risks).toHaveLength(0);
    expect(bp.estimatedSteps).toBe(0);
    expect(bp.deviations).toHaveLength(0);
    expect(bp.builtAt).toBeUndefined();
  });

  it('persists the blueprint to disk', async () => {
    const bp = await createBlueprint('Persist test', '/project');
    const loaded = await loadBlueprint(bp.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.task).toBe('Persist test');
    expect(loaded!.status).toBe('draft');
  });

  it('creates the blueprints directory if it does not exist', async () => {
    const dir = blueprintsDir();
    expect(fs.existsSync(dir)).toBe(false);

    await createBlueprint('Dir create', '/project');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('accepts optional files, data models, dependencies, risks, estimated steps', async () => {
    const bp = await createBlueprint('Full opts', '/project', {
      files: [makeFile({ path: 'src/auth.ts', purpose: 'Auth module' })],
      dataModels: [makeDataModel({ name: 'User', fields: ['id: string', 'email: string'] })],
      dependencies: ['jsonwebtoken', 'bcrypt'],
      risks: ['JWT secret management needs review'],
      estimatedSteps: 5,
    });

    expect(bp.files).toHaveLength(1);
    expect(bp.files[0].path).toBe('src/auth.ts');
    expect(bp.dataModels).toHaveLength(1);
    expect(bp.dataModels[0].name).toBe('User');
    expect(bp.dependencies).toEqual(['jsonwebtoken', 'bcrypt']);
    expect(bp.risks).toHaveLength(1);
    expect(bp.estimatedSteps).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadBlueprint
// ─────────────────────────────────────────────────────────────────────────────
describe('loadBlueprint()', () => {
  it('returns null for unknown blueprint id', async () => {
    const loaded = await loadBlueprint('does-not-exist');
    expect(loaded).toBeNull();
  });

  it('round-trips a full blueprint correctly', async () => {
    const bp = await createBlueprint('Round trip', '/project', {
      files: [makeFile({ path: 'src/a.ts' }), makeFile({ path: 'src/b.ts' })],
      dataModels: [makeDataModel()],
      dependencies: ['lodash'],
      risks: ['performance concern'],
      estimatedSteps: 3,
    });

    const loaded = await loadBlueprint(bp.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.files).toHaveLength(2);
    expect(loaded!.dataModels).toHaveLength(1);
    expect(loaded!.dependencies).toEqual(['lodash']);
    expect(loaded!.risks).toEqual(['performance concern']);
    expect(loaded!.estimatedSteps).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// saveBlueprint
// ─────────────────────────────────────────────────────────────────────────────
describe('saveBlueprint()', () => {
  it('updates persisted data after mutation', async () => {
    const bp = await createBlueprint('Save test', '/project');
    bp.status = 'building';
    bp.risks.push('new risk');
    await saveBlueprint(bp);

    const loaded = await loadBlueprint(bp.id);
    expect(loaded!.status).toBe('building');
    expect(loaded!.risks).toEqual(['new risk']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listBlueprints
// ─────────────────────────────────────────────────────────────────────────────
describe('listBlueprints()', () => {
  it('returns empty array when no blueprints exist', async () => {
    const list = await listBlueprints();
    expect(list).toEqual([]);
  });

  it('returns all saved blueprints', async () => {
    await createBlueprint('BP 1', '/project');
    await createBlueprint('BP 2', '/project');

    const list = await listBlueprints();
    expect(list).toHaveLength(2);
    expect(list.map(b => b.task).sort()).toEqual(['BP 1', 'BP 2']);
  });

  it('returns blueprints sorted by creation time (newest first)', async () => {
    await createBlueprint('Old', '/project');
    await new Promise(r => setTimeout(r, 10));
    await createBlueprint('New', '/project');

    const list = await listBlueprints();
    expect(list[0].task).toBe('New');
    expect(list[1].task).toBe('Old');
  });

  it('skips corrupt JSON files gracefully', async () => {
    await createBlueprint('Valid', '/project');
    fs.writeFileSync(path.join(blueprintsDir(), 'corrupt.json'), 'not json');

    const list = await listBlueprints();
    expect(list).toHaveLength(1);
    expect(list[0].task).toBe('Valid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// markBuilt
// ─────────────────────────────────────────────────────────────────────────────
describe('markBuilt()', () => {
  it('returns null for unknown blueprint id', async () => {
    const result = await markBuilt('nope', 'src/a.ts');
    expect(result).toBeNull();
  });

  it('returns null for unknown file path', async () => {
    const bp = await createBlueprint('Mark test', '/project', {
      files: [makeFile({ path: 'src/a.ts' })],
    });
    const result = await markBuilt(bp.id, 'src/missing.ts');
    expect(result).toBeNull();
  });

  it('marks a single file as built and sets status to partial', async () => {
    const bp = await createBlueprint('Partial build', '/project', {
      files: [
        makeFile({ path: 'src/a.ts' }),
        makeFile({ path: 'src/b.ts' }),
      ],
    });

    const updated = await markBuilt(bp.id, 'src/a.ts');
    expect(updated).not.toBeNull();
    expect(updated!.files[0].status).toBe('built');
    expect(updated!.files[1].status).toBe('planned');
    expect(updated!.status).toBe('partial');
    expect(updated!.builtAt).toBeUndefined();
  });

  it('marks all files as built and sets status to complete', async () => {
    const bp = await createBlueprint('Full build', '/project', {
      files: [
        makeFile({ path: 'src/a.ts' }),
        makeFile({ path: 'src/b.ts' }),
      ],
    });

    await markBuilt(bp.id, 'src/a.ts');
    const complete = await markBuilt(bp.id, 'src/b.ts');

    expect(complete).not.toBeNull();
    expect(complete!.status).toBe('complete');
    expect(complete!.builtAt).toBeDefined();
    expect(complete!.builtAt!).toBeGreaterThan(0);
  });

  it('considers skipped files as resolved', async () => {
    const bp = await createBlueprint('Skip test', '/project', {
      files: [
        makeFile({ path: 'src/a.ts', status: 'skipped' }),
        makeFile({ path: 'src/b.ts' }),
      ],
    });

    const updated = await markBuilt(bp.id, 'src/b.ts');
    expect(updated!.status).toBe('complete');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// addDeviation
// ─────────────────────────────────────────────────────────────────────────────
describe('addDeviation()', () => {
  it('returns null for unknown blueprint id', async () => {
    const result = await addDeviation('nope', 'Changed auth approach');
    expect(result).toBeNull();
  });

  it('appends a deviation to the blueprint', async () => {
    const bp = await createBlueprint('Deviation test', '/project');

    const updated = await addDeviation(bp.id, 'Switched from JWT to session cookies');
    expect(updated).not.toBeNull();
    expect(updated!.deviations).toHaveLength(1);
    expect(updated!.deviations[0].description).toBe('Switched from JWT to session cookies');
    expect(updated!.deviations[0].recordedAt).toBeGreaterThan(0);
  });

  it('accumulates multiple deviations', async () => {
    const bp = await createBlueprint('Multi deviation', '/project');

    await addDeviation(bp.id, 'First change');
    const final = await addDeviation(bp.id, 'Second change');

    expect(final!.deviations).toHaveLength(2);
    expect(final!.deviations[0].description).toBe('First change');
    expect(final!.deviations[1].description).toBe('Second change');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateBlueprintStatus
// ─────────────────────────────────────────────────────────────────────────────
describe('updateBlueprintStatus()', () => {
  it('returns null for unknown blueprint id', async () => {
    const result = await updateBlueprintStatus('nope', 'building');
    expect(result).toBeNull();
  });

  it('updates the status', async () => {
    const bp = await createBlueprint('Status test', '/project');
    const updated = await updateBlueprintStatus(bp.id, 'building');
    expect(updated!.status).toBe('building');
  });

  it('sets builtAt when status is set to complete', async () => {
    const bp = await createBlueprint('Complete test', '/project');
    const updated = await updateBlueprintStatus(bp.id, 'complete');
    expect(updated!.builtAt).toBeDefined();
  });

  it('does not overwrite existing builtAt', async () => {
    const bp = await createBlueprint('Already built', '/project');
    bp.builtAt = 12345;
    bp.status = 'partial';
    await saveBlueprint(bp);

    const updated = await updateBlueprintStatus(bp.id, 'complete');
    expect(updated!.builtAt).toBe(12345);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────
describe('edge cases', () => {
  it('blueprint id format is valid', async () => {
    const bp = await createBlueprint('ID check', '/project');
    expect(bp.id).toMatch(/^[a-f0-9]+-[a-z0-9]+$/);
  });

  it('handles empty files array gracefully', async () => {
    const bp = await createBlueprint('No files', '/project', { files: [] });
    expect(bp.files).toHaveLength(0);

    const result = await markBuilt(bp.id, 'src/nope.ts');
    expect(result).toBeNull();
  });

  it('handles concurrent createBlueprint calls', async () => {
    const [a, b, c] = await Promise.all([
      createBlueprint('A', '/project'),
      createBlueprint('B', '/project'),
      createBlueprint('C', '/project'),
    ]);

    expect(new Set([a.id, b.id, c.id]).size).toBe(3);

    const list = await listBlueprints();
    expect(list).toHaveLength(3);
  });

  it('corrupt version field is still loadable', async () => {
    // Manually write a file with wrong version
    const bp = await createBlueprint('Version test', '/project');
    const filePath = path.join(blueprintsDir(), `${bp.id}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.version = 999;
    fs.writeFileSync(filePath, JSON.stringify(data));

    // Should still load — we don't enforce version
    const loaded = await loadBlueprint(bp.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.task).toBe('Version test');
  });
});
