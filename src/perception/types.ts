// ─────────────────────────────────────────────────────────────────────────────
// Architecture graph nodes
// ─────────────────────────────────────────────────────────────────────────────

/** Structural element in the project knowledge graph. */
export interface ArchitectureNode {
  /** Unique stable identifier for this node (e.g. "src/agent/context.ts"). */
  id: string;
  /** Coarse classification that drives how the node is visualised and queried. */
  type: 'module' | 'file' | 'concept' | 'constraint' | 'decision' | 'trajectory';
  /** Short human-readable label (shown in graph views and summaries). */
  label: string;
  /** Longer explanation of what this node represents or why it matters. */
  description: string;
  /** Arbitrary extra data — provider-specific or tool-specific fields live here. */
  metadata: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Architecture graph edges
// ─────────────────────────────────────────────────────────────────────────────

/** Directed relationship between two nodes in the knowledge graph. */
export interface ArchitectureEdge {
  /** id of the source node. */
  from: string;
  /** id of the target node. */
  to: string;
  /**
   * Semantic type of the relationship.
   * - `depends_on`    — runtime or compile-time dependency
   * - `implements`    — concrete realisation of an abstraction
   * - `deprecated_by` — this edge marks a replacement path
   * - `extends`       — inheritance or mixin
   * - `violates`      — known constraint breach (used with riskAreas)
   * - `aligns_with`   — supports or reinforces a constraint / decision
   * - `owned_by`      — ownership / responsibility link
   * - `tests`         — test file → production target
   */
  relationship:
    | 'depends_on'
    | 'implements'
    | 'deprecated_by'
    | 'extends'
    | 'violates'
    | 'aligns_with'
    | 'owned_by'
    | 'tests';
  /** Confidence / strength of the relationship in [0, 1]. */
  weight: number;
  /** Arbitrary extra data — tracing source, timestamps, tool annotations. */
  metadata: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level perception snapshot
// ─────────────────────────────────────────────────────────────────────────────

/** Full knowledge-graph snapshot for a single project root. */
export interface ProjectPerception {
  /** Absolute path to the project root this snapshot was built from. */
  projectRoot: string;
  /** All nodes in the architecture graph. */
  nodes: ArchitectureNode[];
  /** All directed edges in the architecture graph. */
  edges: ArchitectureEdge[];
  /** High-level trajectory: where the project came from and where it is going. */
  trajectory: {
    /** One-sentence statement of long-term project intent. */
    vision: string;
    /** Node ids (or labels) of things actively being removed or replaced. */
    deprecated: string[];
    /** Node ids (or labels) of work currently in flight. */
    inProgress: string[];
    /** Node ids (or labels) of work not yet started. */
    planned: string[];
  };
  /** Structural constraints extracted from docs, ADRs, and conventions. */
  constraints: {
    /** Paths that must never be modified by automated agents. */
    readOnly: string[];
    /** Rules that must always hold (e.g. "no circular deps in core/"). */
    strictRules: string[];
    /** Areas with known fragility, high change frequency, or tech debt. */
    riskAreas: string[];
    /** Per-module test coverage classification. */
    testCoverage: {
      /** Module name or path prefix. */
      module: string;
      /** Rough coverage level; used to prioritise test generation. */
      coverage: 'high' | 'medium' | 'low';
    }[];
  };
  /** Unix timestamp (ms) when this snapshot was extracted. */
  extractedAt: number;
  /** Semver string of the perception schema used to produce this snapshot. */
  version: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query API
// ─────────────────────────────────────────────────────────────────────────────

/** Parameters for a focused graph query. */
export interface PerceptionQuery {
  /**
   * Kind of information being requested.
   * - `dependencies` — what does `target` depend on (or what depends on it)?
   * - `impact`       — which nodes are affected if `target` changes?
   * - `constraints`  — which rules / risk areas apply to `target`?
   * - `trajectory`   — is `target` deprecated, in-progress, or planned?
   * - `risk`         — aggregated risk score and reasons for `target`
   */
  type: 'dependencies' | 'impact' | 'constraints' | 'trajectory' | 'risk' | 'related';
  /** Node id or label to query against. */
  target: string;
  /** How many hops to traverse from `target` (defaults to 1 when omitted). */
  depth?: number;
}

/** Result returned by a perception query. */
export interface PerceptionQueryResult {
  /** The original query that produced this result. */
  query: PerceptionQuery;
  /** Nodes included in the answer subgraph. */
  nodes: ArchitectureNode[];
  /** Edges included in the answer subgraph. */
  edges: ArchitectureEdge[];
  /** Human-readable explanation of the result, suitable for agent context. */
  summary: string;
}
