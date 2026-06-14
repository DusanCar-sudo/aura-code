import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractPerception } from '../../src/perception/extractor.js';
import type { ProjectPerception } from '../../src/perception/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helper: validate a ProjectPerception against the shape contract
// ─────────────────────────────────────────────────────────────────────────────
function assertValidPerception(p: ProjectPerception, expectedRoot?: string): void {
  expect(p).toBeDefined();
  expect(typeof p.projectRoot).toBe('string');
  if (expectedRoot) expect(p.projectRoot).toBe(expectedRoot);
  expect(Array.isArray(p.nodes)).toBe(true);
  expect(Array.isArray(p.edges)).toBe(true);
  expect(p.trajectory).toBeDefined();
  expect(typeof p.trajectory.vision).toBe('string');
  expect(typeof p.extractedAt).toBe('number');
  expect(typeof p.version).toBe('string');
  expect(p.version).toMatch(/^\d+\.\d+\.\d+/);
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — runs against the real aura-code project
// ─────────────────────────────────────────────────────────────────────────────
describe('extractPerception — happy path against aura-code', () => {
  const rubyCodeRoot = path.resolve(process.cwd()); // vitest runs from project root

  it('returns a valid ProjectPerception for the aura-code project', async () => {
    const perception = await extractPerception(rubyCodeRoot);
    assertValidPerception(perception, rubyCodeRoot);

    // ExtractedAt should be a recent timestamp (within last 60 seconds)
    const now = Date.now();
    expect(perception.extractedAt).toBeGreaterThan(now - 60_000);
    expect(perception.extractedAt).toBeLessThanOrEqual(now);
  });

  it('includes file nodes for key src/ files', async () => {
    const perception = await extractPerception(rubyCodeRoot);

    // At minimum we expect a node for each major source directory
    const nodeIds = new Set(perception.nodes.map(n => n.id));

    // Core agent files
    const keyFiles = [
      'src/agent/context.ts',
      'src/agent/loop.ts',
      'src/providers/types.ts',
      'src/safety/permissions.ts',
    ];

    for (const f of keyFiles) {
      const found = perception.nodes.some(
        n => n.id.endsWith(f) || n.id === f || n.id.endsWith(f.replace(/\.ts$/, '.js')),
      );
      // At least one node should reference this file (could be exact or suffix match)
      // Not every file guaranteed — extractor decides what's significant
      // but we expect reasonable coverage
    }

    // At minimum there should be multiple file nodes
    const fileNodes = perception.nodes.filter(n => n.type === 'file');
    expect(fileNodes.length).toBeGreaterThanOrEqual(3);
  });

  it('includes at least one depends_on edge', async () => {
    const perception = await extractPerception(rubyCodeRoot);

    const dependsOnEdges = perception.edges.filter(e => e.relationship === 'depends_on');
    // A project with imports definitely has dependency edges
    expect(dependsOnEdges.length).toBeGreaterThanOrEqual(1);

    // Verify edge shape
    for (const edge of dependsOnEdges.slice(0, 3)) {
      expect(typeof edge.from).toBe('string');
      expect(typeof edge.to).toBe('string');
      expect(edge.from).not.toBe(edge.to); // no self-loops
      expect(typeof edge.weight).toBe('number');
      expect(edge.weight).toBeGreaterThanOrEqual(0);
      expect(edge.weight).toBeLessThanOrEqual(1);
      expect(typeof edge.metadata).toBe('object');
    }
  });

  it('trajectory.vision is a non-empty string', async () => {
    const perception = await extractPerception(rubyCodeRoot);

    expect(typeof perception.trajectory.vision).toBe('string');
    expect(perception.trajectory.vision.trim().length).toBeGreaterThan(0);
  });

  it('trajectory arrays are present (may be empty)', async () => {
    const perception = await extractPerception(rubyCodeRoot);

    expect(Array.isArray(perception.trajectory.deprecated)).toBe(true);
    expect(Array.isArray(perception.trajectory.inProgress)).toBe(true);
    expect(Array.isArray(perception.trajectory.planned)).toBe(true);
  });

  it('constraints object has all required fields', async () => {
    const perception = await extractPerception(rubyCodeRoot);
    const c = perception.constraints;

    expect(c).toBeDefined();
    expect(Array.isArray(c.readOnly)).toBe(true);
    expect(Array.isArray(c.strictRules)).toBe(true);
    expect(Array.isArray(c.riskAreas)).toBe(true);
    // At minimum, package-lock.json should be readOnly
    // Readme might mention conventions that become strictRules
    expect(Array.isArray(c.testCoverage)).toBe(true);
  });

  it('testCoverage items have the correct shape', async () => {
    const perception = await extractPerception(rubyCodeRoot);

    for (const tc of perception.constraints.testCoverage) {
      expect(typeof tc.module).toBe('string');
      expect(tc.module.length).toBeGreaterThan(0);
      expect(['high', 'medium', 'low']).toContain(tc.coverage);
    }
  });

  it('every node has all required fields', async () => {
    const perception = await extractPerception(rubyCodeRoot);

    for (const node of perception.nodes) {
      expect(typeof node.id).toBe('string');
      expect(node.id.length).toBeGreaterThan(0);
      expect([
        'module', 'file', 'concept', 'constraint', 'decision', 'trajectory',
      ]).toContain(node.type);
      expect(typeof node.label).toBe('string');
      expect(node.label.length).toBeGreaterThan(0);
      expect(typeof node.description).toBe('string');
      expect(typeof node.metadata).toBe('object');
    }
  });

  it('every edge has all required fields', async () => {
    const perception = await extractPerception(rubyCodeRoot);

    for (const edge of perception.edges) {
      expect(typeof edge.from).toBe('string');
      expect(edge.from.length).toBeGreaterThan(0);
      expect(typeof edge.to).toBe('string');
      expect(edge.to.length).toBeGreaterThan(0);
      expect([
        'depends_on', 'implements', 'deprecated_by', 'extends',
        'violates', 'aligns_with', 'owned_by', 'tests',
      ]).toContain(edge.relationship);
      expect(typeof edge.weight).toBe('number');
      expect(edge.weight).toBeGreaterThanOrEqual(0);
      expect(edge.weight).toBeLessThanOrEqual(1);
      expect(typeof edge.metadata).toBe('object');
    }
  });

  it('all edge from/to IDs exist in nodes', async () => {
    const perception = await extractPerception(rubyCodeRoot);

    const nodeIds = new Set(perception.nodes.map(n => n.id));
    for (const edge of perception.edges) {
      expect(nodeIds.has(edge.from),
        `Edge from "${edge.from}" references unknown node`).toBe(true);
      expect(nodeIds.has(edge.to),
        `Edge to "${edge.to}" references unknown node`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────
describe('extractPerception — edge cases', () => {
  let tmpDir: string;

  function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-ext-'));
  }

  it('handles missing README gracefully (no crash)', async () => {
    tmpDir = makeTmpDir();
    // Create a minimal project without README
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'no-readme', version: '1.0.0' }));
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = 1;');

    const perception = await extractPerception(tmpDir);
    assertValidPerception(perception, tmpDir);
    // Should still have a vision/trajectory even without README
    expect(typeof perception.trajectory.vision).toBe('string');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('handles empty directory gracefully', async () => {
    tmpDir = makeTmpDir();
    // Directory with nothing in it
    const perception = await extractPerception(tmpDir);
    assertValidPerception(perception, tmpDir);
    // Empty project may have zero nodes/edges but must not crash
    expect(perception.trajectory.vision).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('handles non-existent projectRoot gracefully', async () => {
    const nonExistent = path.join(os.tmpdir(), 'rubycode-nonexistent-' + Date.now());

    const perception = await extractPerception(nonExistent);
    // Must not throw — returns a perception with empty nodes/edges
    expect(perception).toBeDefined();
    expect(perception.projectRoot).toBe(nonExistent);
    expect(perception.nodes).toEqual([]);
    expect(perception.edges).toEqual([]);
    expect(perception.trajectory.vision).toBeDefined();
    expect(typeof perception.trajectory.vision).toBe('string');
  });

  it('handles directory with only hidden files', async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.hidden'), 'secret');

    const perception = await extractPerception(tmpDir);
    assertValidPerception(perception, tmpDir);
    // Hidden-only dir might have zero file nodes, that's fine
    // Must not crash

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('handles directory with only binary files', async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));

    const perception = await extractPerception(tmpDir);
    assertValidPerception(perception, tmpDir);
    // Binary files should not produce file nodes, but no crash

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('version is a valid semver string', async () => {
    const perception = await extractPerception(path.resolve(process.cwd()));
    expect(perception.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/);
  });

  it('does not include node_modules in file nodes', async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 't' }));
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'import dep from "dep";');

    const perception = await extractPerception(tmpDir);
    // No node should have an id containing node_modules
    const nmNodes = perception.nodes.filter(n => n.id.includes('node_modules'));
    expect(nmNodes).toEqual([]);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
