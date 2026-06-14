// ─────────────────────────────────────────────────────────────────────────────
// Architect types — blueprint-first planning engine
// ─────────────────────────────────────────────────────────────────────────────

/** Status of a single file in a blueprint. */
export type BlueprintFileStatus = 'planned' | 'built' | 'skipped';

/** A file proposed by the architect before any code is written. */
export interface BlueprintFile {
  /** Relative path where the file will live (e.g. "src/auth/jwt.ts"). */
  path: string;
  /** What this file does — one sentence, action-oriented. */
  purpose: string;
  /** Exported symbols this file will provide. */
  exports: string[];
  /** Interfaces or types defined in this file. */
  interfaces: string[];
  /** Whether the file has been built, skipped, or is still planned. */
  status: BlueprintFileStatus;
}

/** A data model proposed in the blueprint (schema / entity). */
export interface BlueprintDataModel {
  /** Name of the data model (e.g. "User", "Session"). */
  name: string;
  /** Field definitions — each string is "fieldName: type" or freeform. */
  fields: string[];
  /** Description of what this model represents. */
  description: string;
}

/** Overall status of a blueprint. */
export type BlueprintStatus = 'draft' | 'building' | 'complete' | 'partial';

/** A deviation recorded when the build diverges from the plan. */
export interface BlueprintDeviation {
  /** What changed vs. the original plan. */
  description: string;
  /** Unix timestamp (ms) when the deviation was recorded. */
  recordedAt: number;
}

/**
 * A blueprint — the architect's plan before any code is written.
 * Saved to ~/.aura/blueprints/<id>.json.
 */
export interface Blueprint {
  /** Unique identifier (hex-timestamp). */
  id: string;
  /** The original task that triggered this blueprint. */
  task: string;
  /** Unix timestamp (ms) when the blueprint was created. */
  createdAt: number;
  /** Overall lifecycle status. */
  status: BlueprintStatus;
  /** Files proposed in this blueprint. */
  files: BlueprintFile[];
  /** Data models proposed in this blueprint. */
  dataModels: BlueprintDataModel[];
  /** External dependencies or internal modules this blueprint depends on. */
  dependencies: string[];
  /** Known risks or concerns flagged by the architect. */
  risks: string[];
  /** Estimated number of implementation steps. */
  estimatedSteps: number;
  /** Deviations recorded during or after build. */
  deviations: BlueprintDeviation[];
  /** Unix timestamp (ms) when the blueprint was marked complete/built. */
  builtAt?: number;
}
