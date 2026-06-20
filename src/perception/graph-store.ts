import * as fs from 'fs';
import * as path from 'path';
import type { ProjectPerception } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Graph store — persistence layer for ProjectPerception snapshots
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialise and persist a perception snapshot to disk.
 * If `filePath` is provided it writes to that exact path; otherwise it
 * derives `{projectRoot}/.aura/perception.json`.
 *
 * Writes atomically (tmp file + rename) so a crash never leaves a partial file.
 * Creates parent directories if they do not already exist.
 */
export async function savePerception(perception: ProjectPerception, filePath?: string): Promise<void> {
  const target = filePath ?? defaultPath(perception.projectRoot);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = target + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(perception, null, 2), 'utf8');
  await fs.promises.rename(tmp, target);
}

/**
 * Load a previously saved perception snapshot from `filePath`.
 * Returns `null` when the file does not exist or cannot be parsed.
 */
export async function loadPerception(filePath: string): Promise<ProjectPerception | null> {
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try { raw = await fs.promises.readFile(filePath, 'utf8'); }
  catch { return null; }

  try {
    const parsed = JSON.parse(raw) as ProjectPerception;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Return `true` when the perception's extractedAt timestamp is older than
 * `maxAgeMs` (default: 1 hour).
 */
export function isStale(perception: ProjectPerception, maxAgeMs?: number): boolean {
  const threshold = maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  // Guard: missing or non-numeric extractedAt should be treated as stale
  if (typeof perception.extractedAt !== 'number' || !Number.isFinite(perception.extractedAt)) return true;
  return Date.now() - perception.extractedAt >= threshold;
}

/**
 * Remove the on-disk perception file.
 * Silently succeeds when the file does not exist.
 */
export async function clearPerception(filePath: string): Promise<void> {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Already gone — no-op
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a ProjectPerception into the flat `{ nodes, edges }` shape that
 * `viz/index.ts#loadGraph()` and `agent/context.ts#loadGraphSummary()` expect,
 * then write it to `<projectRoot>/graphify-out/graph.json`.
 *
 * Node shape:  `{ id, label, type, file?, summary?, source_location? }`
 * Edge shape:  `{ source, target, relation }`
 *
 * Writes atomically (tmp + rename).
 */
export async function saveGraphForViz(perception: ProjectPerception): Promise<void> {
  const dir = path.join(perception.projectRoot, 'graphify-out');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const nodes = perception.nodes.map(n => ({
    id:    n.id,
    label: n.label,
    type:  n.type === 'module' ? 'file' : n.type, // 'module' → 'file' for viz color mapping
    file:  n.type === 'file' ? n.id : (n.metadata?.source as string | undefined),
    summary: n.description?.slice(0, 200),
  }));

  const edges = perception.edges.map(e => ({
    source:   e.from,
    target:   e.to,
    relation: e.relationship,
  }));

  const target = path.join(dir, 'graph.json');
  const tmp = target + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify({ nodes, edges }, null, 2), 'utf8');
  await fs.promises.rename(tmp, target);
}

// ─────────────────────────────────────────────────────────────────────────────

function defaultPath(projectRoot: string): string {
  const dir = path.join(projectRoot, '.aura');
  return path.join(dir, 'perception.json');
}
