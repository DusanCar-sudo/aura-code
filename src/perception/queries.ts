import type { ProjectPerception, ArchitectureNode, ArchitectureEdge, PerceptionQueryResult } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function emptyResult(queryType: string, target: string, reason: string): PerceptionQueryResult {
  return {
    query: { type: queryType as PerceptionQueryResult['query']['type'], target },
    nodes: [],
    edges: [],
    summary: reason,
  };
}

/** Find a node by its id (exact match) or by label (partial match). */
function resolveTarget(perception: ProjectPerception, target: string): ArchitectureNode | null {
  // exact id
  const exact = perception.nodes.find(n => n.id === target);
  if (exact) return exact;

  // exact label
  const labelMatch = perception.nodes.find(n => n.label === target);
  if (labelMatch) return labelMatch;

  // id ends with target
  const suffix = perception.nodes.find(n => n.id.endsWith(target) || n.id.endsWith('/' + target));
  if (suffix) return suffix;

  // label contains target
  const contains = perception.nodes.find(n => n.label.includes(target));
  if (contains) return contains;

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BFS traversal
// ─────────────────────────────────────────────────────────────────────────────

interface BfsResult {
  nodeIds: Set<string>;
  edgeKeys: Set<string>;
}

function bfsTraverse(
  perception: ProjectPerception,
  startId: string,
  direction: 'forward' | 'reverse',
  relationships: string | string[],
  maxDepth: number,
): BfsResult {
  const relSet = new Set(Array.isArray(relationships) ? relationships : [relationships]);
  const visited = new Set<string>();
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];

  visited.add(startId);

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    nodeIds.add(id);
    if (depth >= maxDepth) continue;

    for (const e of perception.edges) {
      if (!relSet.has(e.relationship)) continue;
      const matchId = direction === 'forward' ? e.from : e.to;
      if (matchId !== id) continue;

      const nextId = direction === 'forward' ? e.to : e.from;
      const key = `${e.from}\0${e.to}\0${e.relationship}`;
      edgeKeys.add(key);

      if (!visited.has(nextId)) {
        visited.add(nextId);
        queue.push({ id: nextId, depth: depth + 1 });
      }
    }
  }

  return { nodeIds, edgeKeys };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public query functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What does `fileOrModule` depend on?
 * Performs a BFS following `depends_on` edges to the specified depth (default 1).
 */
export function getDependencies(
  perception: ProjectPerception,
  fileOrModule: string,
  depth = 1,
): PerceptionQueryResult {
  const target = resolveTarget(perception, fileOrModule);
  if (!target) {
    return emptyResult('dependencies', fileOrModule, `No node found matching "${fileOrModule}".`);
  }

  const { nodeIds, edgeKeys } = bfsTraverse(perception, target.id, 'forward', ['depends_on', 'deprecated_by'], depth);

  const existingNodes = perception.nodes.filter(n => nodeIds.has(n.id));
  const existingIds = new Set(existingNodes.map(n => n.id));

  // Create lightweight placeholder nodes for edge targets that don't have
  // full node entries (e.g. a deprecated_by edge pointing to a future file).
  for (const id of nodeIds) {
    if (!existingIds.has(id)) {
      existingNodes.push({
        id,
        type: 'file',
        label: id,
        description: `Referenced by an edge: ${id}`,
        metadata: {},
      });
    }
  }

  const edges = perception.edges.filter(e => edgeKeys.has(`${e.from}\0${e.to}\0${e.relationship}`));

  // don't count the target itself in the dependency list for summary
  const depCount = nodeIds.size - (nodeIds.has(target.id) ? 1 : 0);
  const depNames = existingNodes.filter(n => n.id !== target.id).map(n => n.label).join(', ');

  let summary: string;
  if (depCount === 0) {
    summary = `"${target.label}" has no recorded dependencies at depth ${depth}.`;
  } else {
    summary = `"${target.label}" depends on ${depCount} node${depCount === 1 ? '' : 's'} at depth ${depth}: ${depNames || '(external or unresolved)'}.`;
  }

  return {
    query: { type: 'dependencies', target: target.id },
    nodes: existingNodes,
    edges,
    summary,
  };
}

/**
 * If I change `fileOrModule`, what else is affected?
 * Finds all nodes that depend on this target (reverse `depends_on` lookup).
 */
export function getImpact(
  perception: ProjectPerception,
  fileOrModule: string,
): PerceptionQueryResult {
  const target = resolveTarget(perception, fileOrModule);
  if (!target) {
    return emptyResult('impact', fileOrModule, `No node found matching "${fileOrModule}".`);
  }

  const { nodeIds, edgeKeys } = bfsTraverse(perception, target.id, 'reverse', ['depends_on', 'extends', 'implements', 'tests'], 3);

  const nodes = perception.nodes.filter(n => nodeIds.has(n.id));
  const edges = perception.edges.filter(e => edgeKeys.has(`${e.from}\0${e.to}\0${e.relationship}`));

  const impactCount = nodeIds.size - (nodeIds.has(target.id) ? 1 : 0);
  const impactNames = nodes.filter(n => n.id !== target.id).map(n => n.label).join(', ');

  let summary: string;
  if (impactCount === 0) {
    summary = `Changing "${target.label}" is unlikely to impact other nodes — nothing currently depends on it.`;
  } else {
    summary = `Changing "${target.label}" may impact ${impactCount} node${impactCount === 1 ? '' : 's'}: ${impactNames}. Review these before making changes.`;
  }

  return {
    query: { type: 'impact', target: target.id },
    nodes,
    edges,
    summary,
  };
}

/**
 * What rules, constraints, or risk areas apply to `fileOrModule`?
 * Searches constraint nodes, risk areas, and read-only lists for matches.
 */
export function getConstraints(
  perception: ProjectPerception,
  fileOrModule: string,
): PerceptionQueryResult {
  const target = resolveTarget(perception, fileOrModule);
  const matchId = target?.id ?? fileOrModule;
  const matchLabel = target?.label ?? fileOrModule;

  const relevantNodes: ArchitectureNode[] = [];
  const relevantEdges: ArchitectureEdge[] = [];

  // Check readOnly paths
  for (const ro of perception.constraints.readOnly) {
    if (matchId.startsWith(ro) || matchId === ro) {
      const roNode = perception.nodes.find(n => n.id === `constraint:readonly:${ro}`);
      if (roNode) {
        relevantNodes.push(roNode);
        const edge = perception.edges.find(e => e.from === roNode.id);
        if (edge) relevantEdges.push(edge);
      }
    }
  }

  // Check risk areas
  for (const ra of perception.constraints.riskAreas) {
    if (matchId.startsWith(ra) || matchId === ra) {
      const raNode = perception.nodes.find(n => n.id === ra || n.id === 'constraint:risk-areas');
      if (raNode && !relevantNodes.includes(raNode)) {
        relevantNodes.push(raNode);
      }
      const edge = perception.edges.find(e => (e.from === ra || e.from === matchId) && e.to === 'constraint:risk-areas');
      if (edge) relevantEdges.push(edge);
    }
  }

  // Check constraint / decision nodes related via edges
  for (const e of perception.edges) {
    const isConstraint = ['aligns_with', 'violates', 'implements'].includes(e.relationship);
    if (!isConstraint) continue;
    if (e.from === matchId || e.to === matchId) {
      const otherId = e.from === matchId ? e.to : e.from;
      const node = perception.nodes.find(n => n.id === otherId);
      if (node && (node.type === 'constraint' || node.type === 'decision')) {
        if (!relevantNodes.includes(node)) relevantNodes.push(node);
        if (!relevantEdges.includes(e)) relevantEdges.push(e);
      }
    }
  }

  // Check test coverage for this module
  const moduleDir = pathDir(matchId);
  const tc = perception.constraints.testCoverage.find(t => t.module === moduleDir);

  const readOnlyMatch = perception.constraints.readOnly.some(ro => matchId.startsWith(ro) || matchId === ro);
  const riskMatch = perception.constraints.riskAreas.some(ra => matchId.startsWith(ra) || matchId === ra);

  let summary: string;
  if (relevantNodes.length === 0) {
    summary = `No specific constraints or risk markers apply to "${matchLabel}".`;
  } else {
    const parts: string[] = [];
    if (readOnlyMatch) parts.push('it is marked read-only');
    if (riskMatch) parts.push('it is flagged as a risk area');
    if (tc) parts.push(`test coverage is ${tc.coverage}`);
    if (parts.length === 0) parts.push(`${relevantNodes.length} constraint/decision node(s) relate to this area`);
    summary = `"${matchLabel}" has relevant constraints: ${parts.join('; ')}.`;
  }

  return {
    query: { type: 'constraints', target: matchId },
    nodes: relevantNodes,
    edges: relevantEdges,
    summary,
  };
}

/**
 * Return all known high-risk or fragile areas in the codebase.
 */
export function getRiskAreas(perception: ProjectPerception): PerceptionQueryResult {
  const riskIds = new Set(perception.constraints.riskAreas);
  const relevantNodes: ArchitectureNode[] = [];
  const relevantEdges: ArchitectureEdge[] = [];

  // The constraint node itself
  const raConstraint = perception.nodes.find(n => n.id === 'constraint:risk-areas');
  if (raConstraint) relevantNodes.push(raConstraint);

  // Individual risk area file/module nodes
  for (const raId of riskIds) {
    const node = perception.nodes.find(n => n.id === raId);
    if (node) relevantNodes.push(node);
    const edge = perception.edges.find(e => (e.from === raId || e.to === raId) && e.relationship === 'violates');
    if (edge) relevantEdges.push(edge);
  }

  let summary: string;
  if (riskIds.size === 0) {
    summary = 'No risk areas have been identified in this project.';
  } else {
    const names = [...riskIds].join(', ');
    summary = `${riskIds.size} risk area${riskIds.size === 1 ? '' : 's'} identified: ${names}. These files have TODOs, FIXMEs, or are imported by many other files. Exercise caution when modifying them.`;
  }

  return {
    query: { type: 'risk', target: 'all' },
    nodes: relevantNodes,
    edges: relevantEdges,
    summary,
  };
}

/**
 * Where is the project heading? What's deprecated, in-progress, or planned?
 */
export function getTrajectory(perception: ProjectPerception): PerceptionQueryResult {
  const relevantNodes: ArchitectureNode[] = [];
  const relevantEdges: ArchitectureEdge[] = [];
  const seen = new Set<string>();

  // Deprecated nodes — only return nodes that exist in the perception
  for (const depId of perception.trajectory.deprecated) {
    const node = perception.nodes.find(n => n.id === depId);
    if (node && !seen.has(node.id)) {
      seen.add(node.id);
      relevantNodes.push(node);
    }
    const depEdge = perception.edges.find(e => e.from === depId && e.relationship === 'deprecated_by');
    if (depEdge && !relevantEdges.includes(depEdge)) relevantEdges.push(depEdge);
  }

  // In-progress nodes
  for (const ipId of perception.trajectory.inProgress) {
    const node = perception.nodes.find(n => n.id === ipId);
    if (node && !seen.has(node.id)) {
      seen.add(node.id);
      relevantNodes.push(node);
    }
  }

  // Planned nodes — only include if they exist as real nodes
  for (const pId of perception.trajectory.planned) {
    const node = perception.nodes.find(n => n.id === pId);
    if (node && !seen.has(node.id)) {
      seen.add(node.id);
      relevantNodes.push(node);
    }
  }

  const parts: string[] = [];
  if (perception.trajectory.vision) parts.push(`vision: "${perception.trajectory.vision}"`);
  if (perception.trajectory.deprecated.length) parts.push(`${perception.trajectory.deprecated.length} item(s) deprecated`);
  if (perception.trajectory.inProgress.length) parts.push(`${perception.trajectory.inProgress.length} item(s) in progress`);
  if (perception.trajectory.planned.length) parts.push(`${perception.trajectory.planned.length} item(s) planned`);

  const summary = parts.length > 0
    ? `Project trajectory: ${parts.join('; ')}.`
    : 'No trajectory information has been extracted yet.';

  return {
    query: { type: 'trajectory', target: 'all' },
    nodes: relevantNodes,
    edges: relevantEdges,
    summary,
  };
}

/**
 * Semantic search: find nodes related to `concept` by matching against
 * labels and descriptions (case-insensitive substring match).
 */
export function findRelated(
  perception: ProjectPerception,
  concept: string,
): PerceptionQueryResult {
  const lower = concept.toLowerCase();
  const matched = perception.nodes.filter(n =>
    n.label.toLowerCase().includes(lower) ||
    n.description.toLowerCase().includes(lower) ||
    n.id.toLowerCase().includes(lower),
  );

  if (matched.length === 0) {
    return {
      query: { type: 'related', target: concept },
      nodes: [],
      edges: [],
      summary: `No nodes found related to "${concept}". Try a different search term.`,
    };
  }

  const matchIds = new Set(matched.map(n => n.id));
  const relatedEdges = perception.edges.filter(e => matchIds.has(e.from) || matchIds.has(e.to));

  // Also pull in nodes connected to matched nodes by a single edge
  const extraNodeIds = new Set<string>();
  for (const e of relatedEdges) {
    if (!matchIds.has(e.from)) extraNodeIds.add(e.from);
    if (!matchIds.has(e.to)) extraNodeIds.add(e.to);
  }
  const extraNodes = perception.nodes.filter(n => extraNodeIds.has(n.id));

  const allNodes = [...matched, ...extraNodes];

  const names = matched.map(n => n.label).join(', ');
  const summary = `Found ${matched.length} node${matched.length === 1 ? '' : 's'} related to "${concept}": ${names}.`;

  return {
    query: { type: 'related', target: concept },
    nodes: allNodes,
    edges: relatedEdges,
    summary,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser-compatible path.dirname (avoid import for CommonJS interop)
// ─────────────────────────────────────────────────────────────────────────────

function pathDir(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '.' : p.slice(0, i);
}
