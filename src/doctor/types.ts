/**
 * Aura Doctor — type definitions for the self-diagnostic system.
 *
 * A Finding is a single check result. A DoctorReport is the full scan
 * output. Everything is observational unless the caller passes fix:true,
 * in which case repair.ts attempts auto-repairs and records what it did.
 */

export type Severity = 'ok' | 'warn' | 'error' | 'fixable';

export type Category =
  | 'build'    // dist/ integrity, staleness
  | 'config'   // package.json, tsconfig, .aura.json
  | 'source'   // src/ file integrity
  | 'assets'   // static shipped files
  | 'skills'   // .agents/skills/*/SKILL.md
  | 'deps'     // node_modules, package-lock
  | 'git'      // repo state
  | 'env'      // API keys
  | 'version'  // up-to-date check
  | 'memory'   // episodes, dreams
  | 'hygiene'; // stray non-aura files/dirs in the repo root

export interface Finding {
  category: Category;
  name: string;
  severity: Severity;
  message: string;
  detail?: string;
  /** Whether runDoctor({fix:true}) can attempt to repair this. */
  fixable: boolean;
  /** Human description of what the fix does, shown when not auto-fixing. */
  fixDescription?: string;
}

export interface DoctorReport {
  timestamp: number;
  version: string;
  projectRoot: string;
  findings: Finding[];
  summary: Record<Severity, number>;
  /** Names of findings that were auto-repaired (only when fix:true). */
  fixed: string[];
  /** Names of findings where repair was attempted but failed. */
  fixFailed: string[];
}

export interface DoctorOptions {
  projectRoot: string;
  /** Attempt auto-repair for fixable findings. */
  fix?: boolean;
  /** Skip checks that hit the network (version check). */
  offline?: boolean;
}
