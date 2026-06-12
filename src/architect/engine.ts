import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  Blueprint,
  BlueprintFile,
  BlueprintDataModel,
  BlueprintDeviation,
  BlueprintStatus,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BLUEPRINT_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomBytes(4).toString('hex') + '-' + Date.now().toString(36);
}

/** Returns ~/.rubycode/blueprints (or $RUBY_BLUEPRINT_DIR if set). */
export function blueprintsDir(): string {
  return process.env.RUBY_BLUEPRINT_DIR
    ?? path.join(process.env.HOME ?? '/tmp', '.rubycode', 'blueprints');
}

function blueprintPath(id: string): string {
  return path.join(blueprintsDir(), `${id}.json`);
}

/** Atomically write JSON to a file using a .tmp rename. */
async function writeJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tmp, filePath);
}

/** Read and parse a JSON file; returns null on any error. */
async function readJson<T>(filePath: string): Promise<T | null> {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// createBlueprint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new blueprint from an architect's analysis.
 * Persists to ~/.rubycode/blueprints/<id>.json.
 *
 * @param task        — the original user task
 * @param _projectRoot — the project root (reserved for future context loading)
 * @param opts        — optional overrides for files, models, deps, etc.
 */
export async function createBlueprint(
  task: string,
  _projectRoot: string,
  opts: {
    files?: BlueprintFile[];
    dataModels?: BlueprintDataModel[];
    dependencies?: string[];
    risks?: string[];
    estimatedSteps?: number;
  } = {},
): Promise<Blueprint> {
  const id = generateId();
  const now = Date.now();

  const blueprint: Blueprint = {
    id,
    task,
    createdAt: now,
    status: 'draft',
    files: opts.files ?? [],
    dataModels: opts.dataModels ?? [],
    dependencies: opts.dependencies ?? [],
    risks: opts.risks ?? [],
    estimatedSteps: opts.estimatedSteps ?? 0,
    deviations: [],
  };

  await writeJson(blueprintPath(id), { version: BLUEPRINT_VERSION, blueprint });
  return blueprint;
}

// ─────────────────────────────────────────────────────────────────────────────
// loadBlueprint
// ─────────────────────────────────────────────────────────────────────────────

/** Loads a blueprint from disk by ID. Returns null if not found. */
export async function loadBlueprint(id: string): Promise<Blueprint | null> {
  const raw = await readJson<{ version: number; blueprint: Blueprint }>(blueprintPath(id));
  if (!raw || !raw.blueprint) return null;
  return raw.blueprint;
}

// ─────────────────────────────────────────────────────────────────────────────
// saveBlueprint
// ─────────────────────────────────────────────────────────────────────────────

/** Persists the current blueprint to disk. */
export async function saveBlueprint(blueprint: Blueprint): Promise<void> {
  await writeJson(blueprintPath(blueprint.id), { version: BLUEPRINT_VERSION, blueprint });
}

// ─────────────────────────────────────────────────────────────────────────────
// listBlueprints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lists all persisted blueprints.
 * Returns an array of blueprints sorted by creation time (newest first).
 */
export async function listBlueprints(): Promise<Blueprint[]> {
  const dir = blueprintsDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const blueprints: Blueprint[] = [];

  for (const file of files) {
    const raw = await readJson<{ version: number; blueprint: Blueprint }>(
      path.join(dir, file),
    );
    if (raw && raw.blueprint) {
      blueprints.push(raw.blueprint);
    }
  }

  return blueprints.sort((a, b) => b.createdAt - a.createdAt);
}

// ─────────────────────────────────────────────────────────────────────────────
// markBuilt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Marks a specific file in a blueprint as built.
 * Updates the blueprint status: if all files are now built/skipped → 'complete',
 * otherwise → 'partial'.
 *
 * @param id   — blueprint ID
 * @param filePath — the file path to mark as built
 * @returns the updated blueprint, or null if not found
 */
export async function markBuilt(id: string, filePath: string): Promise<Blueprint | null> {
  const blueprint = await loadBlueprint(id);
  if (!blueprint) return null;

  const file = blueprint.files.find(f => f.path === filePath);
  if (!file) return null;

  file.status = 'built';

  // Recalculate blueprint status
  const allResolved = blueprint.files.every(f => f.status !== 'planned');
  blueprint.status = allResolved ? 'complete' : 'partial';
  blueprint.builtAt = allResolved ? Date.now() : blueprint.builtAt;

  await saveBlueprint(blueprint);
  return blueprint;
}

// ─────────────────────────────────────────────────────────────────────────────
// addDeviation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records a deviation from the original blueprint plan.
 *
 * @param id         — blueprint ID
 * @param deviation  — description of what changed
 * @returns the updated blueprint, or null if not found
 */
export async function addDeviation(id: string, deviation: string): Promise<Blueprint | null> {
  const blueprint = await loadBlueprint(id);
  if (!blueprint) return null;

  const entry: BlueprintDeviation = {
    description: deviation,
    recordedAt: Date.now(),
  };
  blueprint.deviations.push(entry);

  await saveBlueprint(blueprint);
  return blueprint;
}

// ─────────────────────────────────────────────────────────────────────────────
// updateBlueprintStatus
// ─────────────────────────────────────────────────────────────────────────────

/** Updates the overall status of a blueprint. */
export async function updateBlueprintStatus(id: string, status: BlueprintStatus): Promise<Blueprint | null> {
  const blueprint = await loadBlueprint(id);
  if (!blueprint) return null;

  blueprint.status = status;
  if (status === 'complete' && !blueprint.builtAt) {
    blueprint.builtAt = Date.now();
  }

  await saveBlueprint(blueprint);
  return blueprint;
}
