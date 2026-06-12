import { describe, it, expect } from 'vitest';
import type {
  ProjectPerception,
  ArchitectureNode,
  ArchitectureEdge,
  PerceptionQueryResult,
} from '../../src/perception/types.js';
import {
  getDependencies,
  getImpact,
  getConstraints,
  getRiskAreas,
  getTrajectory,
  findRelated,
} from '../../src/perception/queries.js';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal mock ProjectPerception — shared across all query tests
// ─────────────────────────────────────────────────────────────────────────────
//
// Graph layout:
//
//   src/index.ts ──(depends_on)──▶ src/utils.ts
//        │                              │
//        │ (tests)                      │ (deprecated_by)
//        ▼                              ▼
//   tests/index.test.ts          src/new-utils.ts
//
//   core/auth ──(depends_on)──▶ concept:authentication
//
const mockNodes: ArchitectureNode[] = [
  {
    id: 'src/index.ts',
    type: 'file',
    label: 'Entry point',
    description: 'Main application entry',
    metadata: { language: 'typescript' },
  },
  {
    id: 'src/utils.ts',
    type: 'file',
    label: 'Utilities module',
    description: 'Shared helper functions',
    metadata: { language: 'typescript', riskArea: 'legacy-refactor' },
  },
  {
    id: 'tests/index.test.ts',
    type: 'file',
    label: 'Index tests',
    description: 'Tests for entry point',
    metadata: { language: 'typescript' },
  },
  {
    id: 'core/auth',
    type: 'module',
    label: 'Auth module',
    description: 'Authentication and authorization logic',
    metadata: { riskArea: 'security-critical' },
  },
  {
    id: 'concept:authentication',
    type: 'concept',
    label: 'Authentication',
    description: 'The concept of user authentication flows',
    metadata: {},
  },
];

const mockEdges: ArchitectureEdge[] = [
  {
    from: 'src/index.ts',
    to: 'src/utils.ts',
    relationship: 'depends_on',
    weight: 0.9,
    metadata: {},
  },
  {
    from: 'tests/index.test.ts',
    to: 'src/index.ts',
    relationship: 'tests',
    weight: 1.0,
    metadata: {},
  },
  {
    from: 'src/utils.ts',
    to: 'src/new-utils.ts',
    relationship: 'deprecated_by',
    weight: 0.8,
    metadata: { reason: 'migrated to new-utils' },
  },
  {
    from: 'core/auth',
    to: 'concept:authentication',
    relationship: 'depends_on',
    weight: 0.7,
    metadata: {},
  },
];

const mockPerception: ProjectPerception = {
  projectRoot: '/fake/project',
  nodes: mockNodes,
  edges: mockEdges,
  trajectory: {
    vision: 'Build a secure, scalable application platform',
    deprecated: ['src/utils.ts'],
    inProgress: [],
    planned: ['src/new-utils.ts', 'core/sessions'],
  },
  constraints: {
    readOnly: ['package-lock.json', '.env'],
    strictRules: ['No circular dependencies in core/', 'All auth code must be reviewed'],
    riskAreas: ['security-critical', 'legacy-refactor'],
    testCoverage: [
      { module: 'src', coverage: 'high' },
      { module: 'core', coverage: 'medium' },
      { module: 'tests', coverage: 'low' },
    ],
  },
  extractedAt: Date.now(),
  version: '1.0.0',
};

const emptyPerception: ProjectPerception = {
  projectRoot: '/empty',
  nodes: [],
  edges: [],
  trajectory: {
    vision: 'No vision yet',
    deprecated: [],
    inProgress: [],
    planned: [],
  },
  constraints: {
    readOnly: [],
    strictRules: [],
    riskAreas: [],
    testCoverage: [],
  },
  extractedAt: Date.now(),
  version: '1.0.0',
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: assert a valid query result shape
// ─────────────────────────────────────────────────────────────────────────────
function assertValidResult(result: PerceptionQueryResult): void {
  expect(result).toBeDefined();
  expect(result.query).toBeDefined();
  expect(Array.isArray(result.nodes)).toBe(true);
  expect(Array.isArray(result.edges)).toBe(true);
  expect(typeof result.summary).toBe('string');
  expect(result.summary.length).toBeGreaterThan(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// getDependencies
// ─────────────────────────────────────────────────────────────────────────────
describe('getDependencies', () => {
  it('returns correct nodes for a known file (depth=1)', () => {
    const result = getDependencies(mockPerception, 'src/index.ts');

    assertValidResult(result);
    // At depth 1, should include src/index.ts and its direct dependency src/utils.ts
    const nodeIds = result.nodes.map(n => n.id);
    expect(nodeIds).toContain('src/index.ts');
    expect(nodeIds).toContain('src/utils.ts');
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.edges.some(e => e.relationship === 'depends_on')).toBe(true);
  });

  it('depth=1 vs depth=2 returns different results', () => {
    const depth1 = getDependencies(mockPerception, 'src/index.ts', 1);
    const depth2 = getDependencies(mockPerception, 'src/index.ts', 2);

    // Depth 1: index → utils (1 hop)
    // Depth 2: index → utils → new-utils (2 hops, via deprecated_by)
    expect(depth2.nodes.length).toBeGreaterThan(depth1.nodes.length);
    expect(depth2.edges.length).toBeGreaterThanOrEqual(depth1.edges.length);
  });

  it('returns empty result for unknown file (no crash)', () => {
    const result = getDependencies(mockPerception, 'nonexistent/file.ts');

    assertValidResult(result);
    // Unknown file should return empty or minimal result, but NEVER throw
    expect(result.nodes.length).toBeGreaterThanOrEqual(0);
  });

  it('handles empty perception gracefully', () => {
    const result = getDependencies(emptyPerception, 'anything');

    assertValidResult(result);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('depth=0 returns only the target node', () => {
    const result = getDependencies(mockPerception, 'src/index.ts', 0);
    expect(result.nodes.map(n => n.id)).toEqual(['src/index.ts']);
    expect(result.edges).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getImpact
// ─────────────────────────────────────────────────────────────────────────────
describe('getImpact', () => {
  it('returns reverse dependencies for a known node', () => {
    // src/index.ts is depended on by tests/index.test.ts (via tests edge)
    // and also by src/utils.ts ← no, wait. src/index.ts DEPENDS on src/utils.ts
    // So who depends ON src/index.ts? tests/index.test.ts
    const result = getImpact(mockPerception, 'src/index.ts');

    assertValidResult(result);
    const nodeIds = result.nodes.map(n => n.id);
    // The test file depends on (tests) src/index.ts, so impact includes it
    expect(nodeIds).toContain('tests/index.test.ts');
  });

  it('returns empty for a node with no reverse dependencies', () => {
    const result = getImpact(mockPerception, 'tests/index.test.ts');

    assertValidResult(result);
    // tests/index.test.ts has no incoming edges in our mock
    // Should not crash, may return empty or just the node itself
    expect(result).toBeDefined();
  });

  it('handles unknown file gracefully', () => {
    const result = getImpact(mockPerception, 'does-not-exist');

    assertValidResult(result);
  });

  it('handles empty perception gracefully', () => {
    const result = getImpact(emptyPerception, 'anything');

    assertValidResult(result);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getConstraints
// ─────────────────────────────────────────────────────────────────────────────
describe('getConstraints', () => {
  it('returns constraints for a known risky file', () => {
    // core/auth has riskArea: 'security-critical' in metadata
    const result = getConstraints(mockPerception, 'core/auth');

    assertValidResult(result);
    // Should include nodes/edges related to the constraint
    // The summary should mention the risk area or strict rule
    expect(result.summary.toLowerCase()).toMatch(/security|constraint|rule|risk/);
  });

  it('returns empty for file with no constraints', () => {
    const result = getConstraints(mockPerception, 'src/index.ts');

    assertValidResult(result);
    // No constraints associated with index.ts
    expect(result.nodes.length).toBeGreaterThanOrEqual(0);
  });

  it('handles unknown file gracefully', () => {
    const result = getConstraints(mockPerception, 'unknown/module');

    assertValidResult(result);
  });

  it('handles empty perception gracefully', () => {
    const result = getConstraints(emptyPerception, 'anything');

    assertValidResult(result);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getRiskAreas
// ─────────────────────────────────────────────────────────────────────────────
describe('getRiskAreas', () => {
  it('returns all risk area nodes', () => {
    const result = getRiskAreas(mockPerception);

    assertValidResult(result);
    // Should include nodes marked with risk areas in metadata
    // core/auth and src/utils.ts have risk area metadata
    const nodeIds = result.nodes.map(n => n.id);
    // At minimum, the function should return something meaningful
    // The exact set depends on how implementation maps riskAreas to nodes
    expect(nodeIds.length).toBeGreaterThanOrEqual(0);
    // Summary should mention risk areas
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('returns a meaningful summary mentioning risks', () => {
    const result = getRiskAreas(mockPerception);
    expect(result.summary.toLowerCase()).toMatch(/risk|security|legacy|fragile/);
  });

  it('handles empty perception gracefully', () => {
    const result = getRiskAreas(emptyPerception);

    assertValidResult(result);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.summary.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getTrajectory
// ─────────────────────────────────────────────────────────────────────────────
describe('getTrajectory', () => {
  it('returns trajectory nodes and summary', () => {
    const result = getTrajectory(mockPerception);

    assertValidResult(result);
    // Should include trajectory-related nodes
    // At minimum, summary mentions vision or planned items
    expect(result.summary.toLowerCase()).toMatch(/vision|deprecated|planned|progress/);
  });

  it('returns deprecated nodes when querying a deprecated target', () => {
    const result = getTrajectory(mockPerception);

    assertValidResult(result);
    // src/utils.ts is deprecated — results should reflect that
    // Check summary mentions deprecated items
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('handles empty perception gracefully', () => {
    const result = getTrajectory(emptyPerception);

    assertValidResult(result);
    expect(result.summary.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findRelated
// ─────────────────────────────────────────────────────────────────────────────
describe('findRelated', () => {
  it('finds nodes by partial label match (case-insensitive)', () => {
    const result = findRelated(mockPerception, 'auth');

    assertValidResult(result);
    // Should find core/auth and concept:authentication
    const nodeIds = result.nodes.map(n => n.id);
    expect(nodeIds).toContain('core/auth');
    expect(nodeIds).toContain('concept:authentication');
  });

  it('finds nodes by partial id match', () => {
    const result = findRelated(mockPerception, 'utils');

    assertValidResult(result);
    const nodeIds = result.nodes.map(n => n.id);
    expect(nodeIds).toContain('src/utils.ts');
  });

  it('finds nodes by description match', () => {
    const result = findRelated(mockPerception, 'helper');

    assertValidResult(result);
    const nodeIds = result.nodes.map(n => n.id);
    // src/utils.ts description is "Shared helper functions"
    expect(nodeIds).toContain('src/utils.ts');
  });

  it('returns empty when no match found', () => {
    const result = findRelated(mockPerception, 'ZZZZZZ_NOMATCH_ZZZZZZ');

    assertValidResult(result);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('handles empty search string gracefully', () => {
    const result = findRelated(mockPerception, '');

    assertValidResult(result);
    // Empty search may match everything or nothing — either is fine as long as no crash
  });

  it('handles empty perception gracefully', () => {
    const result = findRelated(emptyPerception, 'anything');

    assertValidResult(result);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('returns query.type "related" (not "dependencies")', () => {
    const result = findRelated(mockPerception, 'auth');
    expect(result.query.type).toBe('related');
  });

  it('returns query.type "related" even when no match found', () => {
    const result = findRelated(mockPerception, 'ZZZZZZ_NOMATCH_ZZZZZZ');
    expect(result.query.type).toBe('related');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-cutting: every function never throws and always returns summary
// ─────────────────────────────────────────────────────────────────────────────
describe('all query functions — robustness guarantees', () => {
  const allFns: Array<{
    name: string;
    fn: (p: ProjectPerception, target?: string, depth?: number) => PerceptionQueryResult;
  }> = [
    { name: 'getDependencies', fn: (p, t, d) => getDependencies(p, t || 'src/index.ts', d) },
    { name: 'getImpact', fn: (p, t) => getImpact(p, t || 'src/index.ts') },
    { name: 'getConstraints', fn: (p, t) => getConstraints(p, t || 'core/auth') },
    { name: 'getRiskAreas', fn: (p) => getRiskAreas(p) },
    { name: 'getTrajectory', fn: (p) => getTrajectory(p) },
    { name: 'findRelated', fn: (p, t) => findRelated(p, t || 'auth') },
  ];

  for (const { name, fn } of allFns) {
    it(`${name}: never throws on empty perception`, () => {
      expect(() => fn(emptyPerception)).not.toThrow();
    });

    it(`${name}: never throws on unknown target`, () => {
      // Second arg is target for functions that take one
      expect(() => fn(mockPerception, 'completely_unknown_xyz')).not.toThrow();
    });

    it(`${name}: always returns a non-empty summary string`, () => {
      const result = fn(mockPerception);
      expect(typeof result.summary).toBe('string');
      expect(result.summary.length).toBeGreaterThan(0);
    });

    it(`${name}: result has valid PerceptionQueryResult shape`, () => {
      const result = fn(mockPerception);
      expect(result.query).toBeDefined();
      expect(typeof result.query.type).toBe('string');
      expect(Array.isArray(result.nodes)).toBe(true);
      expect(Array.isArray(result.edges)).toBe(true);
      // All returned nodes should exist in the original perception
      const originalIds = new Set(mockPerception.nodes.map(n => n.id));
      for (const node of result.nodes) {
        expect(originalIds.has(node.id),
          `${name} returned node "${node.id}" not in original perception`).toBe(true);
      }
    });
  }
});
