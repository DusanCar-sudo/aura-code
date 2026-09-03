import * as fs from 'fs';
import * as path from 'path';
import { extractPerception } from './extractor.js';
import type { ProjectPerception, ArchitectureNode, ArchitectureEdge } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Graphify — extract a ProjectPerception and write it to
// graphify-out/graph.json in the format expected by the viz dashboard
// and loadGraphSummary().
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The on-disk shape of graphify-out/graph.json.
 * Nodes use `summary` (not `description`) and an optional `file` path;
 * edges use `source`/`target` (not `from`/`to`) with an optional `relation`.
 */
export interface GraphifyNode {
  id: string;
  type: string;
  label: string;
  summary?: string;
  file?: string;
}

export interface GraphifyEdge {
  source: string;
  target: string;
  relation?: string;
}

export interface GraphifyGraph {
  nodes: GraphifyNode[];
  edges: GraphifyEdge[];
  extractedAt: number;
}

/**
 * Convert a ProjectPerception (the internal architecture-graph format) into
 * the graphify-out/graph.json shape used by the viz dashboard and :graph.
 *
 * - Node `description` → `summary`
 * - Node `metadata.file` (if present) → top-level `file`
 * - Edge `from`/`to` → `source`/`target`
 * - Edge `relationship` → `relation`
 */
export function toGraphify(perception: ProjectPerception): GraphifyGraph {
  const nodes: GraphifyNode[] = perception.nodes.map((n: ArchitectureNode) => {
    const gn: GraphifyNode = {
      id: n.id,
      type: n.type,
      label: n.label,
    };
    if (n.description) gn.summary = n.description;
    const metaFile = n.metadata?.file;
    if (typeof metaFile === 'string') gn.file = metaFile;
    // For file-type nodes, the id IS the file path.
    if (!gn.file && n.type === 'file') gn.file = n.id;
    return gn;
  });

  const edges: GraphifyEdge[] = perception.edges.map((e: ArchitectureEdge) => ({
    source: e.from,
    target: e.to,
    relation: e.relationship,
  }));

  return {
    nodes,
    edges,
    extractedAt: perception.extractedAt,
  };
}

/**
 * Extract a fresh perception snapshot from the project at `projectRoot`,
 * convert it to the graphify-out format, and write it to
 * `{projectRoot}/graphify-out/graph.json`.
 *
 * Returns the output path on success.
 */
export async function extractGraph(projectRoot: string): Promise<string> {
  const perception = await extractPerception(projectRoot);
  const graph = toGraphify(perception);

  const outDir = path.join(projectRoot, 'graphify-out');
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, 'graph.json');
  fs.writeFileSync(outPath, JSON.stringify(graph, null, 2), 'utf8');

  return outPath;
}
