/**
 * Aura Doctor — repair module. Each function attempts to fix a specific
 * class of finding and returns true on success, false on failure.
 *
 * Repairs use direct execSync / fs calls — they never go through the agent
 * tool layer (the safety layer blocks git checkout/reset for telegram, and
 * the agent has no git_restore tool anyway).
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { Finding } from './types.js';

function sh(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(String(e));
  }
}

export interface RepairResult {
  name: string;
  success: boolean;
  message: string;
}

/** Rebuild dist/ from src/ via `npm run build`. */
export function repairBuild(root: string): RepairResult {
  try {
    sh('npm run build', root);
    return { name: 'rebuild dist', success: true, message: 'Rebuilt dist/ via npm run build.' };
  } catch (e) {
    return { name: 'rebuild dist', success: false, message: `Build failed: ${String(e).slice(0, 200)}` };
  }
}

/** Restore a git-tracked file to its committed state via `git restore`. */
export function repairGitFile(root: string, fileRel: string): RepairResult {
  try {
    sh(`git restore -- "${fileRel}"`, root);
    return { name: `restore ${fileRel}`, success: true, message: `Restored ${fileRel} from git.` };
  } catch (e) {
    return { name: `restore ${fileRel}`, success: false, message: `Could not restore: ${String(e).slice(0, 200)}` };
  }
}

/** Run npm install to restore missing node_modules. */
export function repairDeps(root: string): RepairResult {
  try {
    sh('npm install', root);
    return { name: 'npm install', success: true, message: 'Dependencies installed.' };
  } catch (e) {
    return { name: 'npm install', success: false, message: `npm install failed: ${String(e).slice(0, 200)}` };
  }
}

/** Delete a corrupted file (e.g. invalid identity.json). */
export function repairDelete(root: string, absPath: string): RepairResult {
  try {
    fs.unlinkSync(absPath);
    return { name: `delete ${path.basename(absPath)}`, success: true, message: `Deleted ${absPath}.` };
  } catch (e) {
    return { name: `delete ${path.basename(absPath)}`, success: false, message: `Could not delete: ${String(e).slice(0, 200)}` };
  }
}

/**
 * Attempt to repair a single finding. Returns the repair result, or null
 * if the finding is not auto-repairable or doesn't map to a known repair.
 */
export function attemptRepair(root: string, finding: Finding): RepairResult | null {
  if (!finding.fixable) return null;

  // Build staleness / missing dist
  if (finding.category === 'build' && (finding.name === 'dist directory' || finding.name === 'entry point' || finding.name === 'dist freshness')) {
    return repairBuild(root);
  }

  // Missing node_modules or key deps
  if (finding.category === 'deps' && (finding.name === 'node_modules' || finding.name.startsWith('dep:'))) {
    return repairDeps(root);
  }

  // Corrupted identity.json
  if (finding.category === 'memory' && finding.name === 'identity') {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
    return repairDelete(root, path.join(home, '.aura', 'memory', 'identity.json'));
  }

  // Corrupted .aura.json — suggest deletion (don't auto-delete config the user wrote)
  if (finding.category === 'config' && finding.name === '.aura.json') {
    return { name: '.aura.json', success: false, message: 'Cannot auto-repair .aura.json — fix the JSON syntax manually or delete it to use defaults.' };
  }

  return null;
}
