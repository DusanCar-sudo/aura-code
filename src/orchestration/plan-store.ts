import * as fs from 'fs';
import * as path from 'path';
import type { ExecutionPlan, OrchestrationMemory } from './types.js';

// Serialises concurrent writes to the same memory file so parallel steps
// cannot clobber each other's entries (read-modify-write race condition).
const writeLocks = new Map<string, Promise<void>>();

/**
 * On-disk persistence for execution plans and orchestration memory.
 *
 * Plans are stored as individual JSON files under ~/.aura/plans/{id}.json
 * so they survive process restarts and can be inspected or replayed.
 *
 * Per-project memory is appended to {projectRoot}/.aura/memory.json and
 * keyed by a string so specialists can share facts across steps.
 */
export const planStore = {
  /** Returns the directory where plan files are stored. */
  plansDir(): string {
    return path.join(process.env.HOME ?? '/tmp', '.aura', 'plans');
  },

  /**
   * Persists an execution plan to ~/.aura/plans/{id}.json.
   * Uses a .tmp rename to avoid corrupt files on crash.
   */
  async save(plan: ExecutionPlan): Promise<void> {
    const dir = this.plansDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${plan.id}.json`);
    const tmp = filePath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(plan, null, 2), 'utf8');
    await fs.promises.rename(tmp, filePath);
  },

  /**
   * Loads a plan by id.
   * Returns `null` if the file does not exist or cannot be parsed.
   */
  async load(id: string): Promise<ExecutionPlan | null> {
    const filePath = path.join(this.plansDir(), `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    const raw = await fs.promises.readFile(filePath, 'utf8');
    try {
      return JSON.parse(raw) as ExecutionPlan;
    } catch {
      return null;
    }
  },

  /**
   * Returns all saved plans, most recently created first.
   * Silently skips files that cannot be parsed.
   */
  async list(): Promise<ExecutionPlan[]> {
    const dir = this.plansDir();
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const plans: ExecutionPlan[] = [];
    for (const file of files) {
      const raw = await fs.promises.readFile(path.join(dir, file), 'utf8');
      try {
        plans.push(JSON.parse(raw) as ExecutionPlan);
      } catch {
        /* skip corrupt file */
      }
    }
    return plans.sort((a, b) => b.created - a.created);
  },

  /**
   * Removes a plan file from disk.
   * Resolves silently if the file does not exist.
   */
  async delete(id: string): Promise<void> {
    const filePath = path.join(this.plansDir(), `${id}.json`);
    if (!fs.existsSync(filePath)) return;
    await fs.promises.unlink(filePath);
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Per-project orchestration memory
  // ───────────────────────────────────────────────────────────────────────────

  /** Returns the path to the memory file for a given project root. */
  memoryPath(projectRoot: string): string {
    return path.join(projectRoot, '.aura', 'memory.json');
  },

  /**
   * Appends a memory entry to {projectRoot}/.aura/memory.json.
   * Creates the file (and parent directory) if they do not yet exist.
   * Uses a .tmp rename to avoid corrupt files on crash.
   */
  async saveMemory(projectRoot: string, entry: OrchestrationMemory): Promise<void> {
    const filePath = this.memoryPath(projectRoot);
    const existing = writeLocks.get(filePath) ?? Promise.resolve();
    const next = existing.then(async () => {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const entries = await this.listMemory(projectRoot);
      entries.push(entry);
      const tmp = filePath + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8');
      await fs.promises.rename(tmp, filePath);
    });
    writeLocks.set(filePath, next);
    return next;
  },

  /**
   * Returns the most recent memory entry matching `key`, or `null` if none
   * exists.  When multiple entries share the same key, the latest timestamp
   * wins.
   */
  async getMemory(projectRoot: string, key: string): Promise<OrchestrationMemory | null> {
    const all = await this.listMemory(projectRoot);
    const matches = all.filter(e => e.key === key);
    if (matches.length === 0) return null;
    return matches.reduce((best, e) => (e.timestamp > best.timestamp ? e : best));
  },

  /**
   * Returns all memory entries for a project, sorted newest-first.
   * Returns an empty array if the memory file does not exist.
   */
  async listMemory(projectRoot: string): Promise<OrchestrationMemory[]> {
    const filePath = this.memoryPath(projectRoot);
    if (!fs.existsSync(filePath)) return [];
    const raw = await fs.promises.readFile(filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? (parsed as OrchestrationMemory[]).sort((a, b) => b.timestamp - a.timestamp)
        : [];
    } catch {
      return [];
    }
  },
};
