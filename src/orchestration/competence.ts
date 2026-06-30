import * as fs from 'fs';
import * as path from 'path';
import type { PlanStep } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Competence types
// ─────────────────────────────────────────────────────────────────────────────

export type SpecialistRole = PlanStep['specialist'];

/**
 * Task domains used to score which specialist performs best.
 * Maps loosely to PlanStep.specialist roles but allows finer routing.
 */
export type CompetenceDomain =
  | 'research'
  | 'implementation'
  | 'review'
  | 'planning'
  | 'ruby_gems'
  | 'ruby_tests'
  | 'refactor';

/** A single specialist's score in one domain, learned over time. */
export interface CompetenceScore {
  specialist: SpecialistRole;
  domain: CompetenceDomain;
  /** Performance estimate in [0, 1]. */
  score: number;
  /** Number of step outcomes that contributed to this score. */
  sampleCount: number;
  /** Unix timestamp (ms) of the last update. */
  lastUpdated: number;
}

/** Per-project competence profile persisted on disk. */
export interface ProjectCompetence {
  projectRoot: string;
  scores: CompetenceScore[];
  version: 1;
}

/** Outcome signal fed back after a plan step finishes. */
export interface StepOutcome {
  specialist: SpecialistRole;
  domain: CompetenceDomain;
  /** Whether the step reached `done` (not `failed` or `skipped`). */
  success: boolean;
  /** Optional normalised quality in [0, 1] from reviewer or heuristics. */
  quality?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults — prior beliefs before any project-specific learning
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PRIORS: Record<SpecialistRole, Partial<Record<CompetenceDomain, number>>> = {
  researcher: { research: 0.9, implementation: 0.4, ruby_gems: 0.6, refactor: 0.5 },
  coder: { implementation: 0.9, ruby_gems: 0.85, ruby_tests: 0.7, refactor: 0.8, research: 0.35 },
  reviewer: { review: 0.95, implementation: 0.5, refactor: 0.6 },
  planner: { planning: 0.95, research: 0.7, refactor: 0.55 },
};

/** Maps each specialist role to its primary competence domain. */
export const PRIMARY_DOMAIN: Record<SpecialistRole, CompetenceDomain> = {
  researcher: 'research',
  coder: 'implementation',
  reviewer: 'review',
  planner: 'planning',
};

function key(specialist: SpecialistRole, domain: CompetenceDomain): string {
  return `${specialist}:${domain}`;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Builds the initial competence matrix from role priors. */
export function defaultCompetenceMatrix(): CompetenceScore[] {
  const scores: CompetenceScore[] = [];
  const now = Date.now();
  for (const specialist of Object.keys(DEFAULT_PRIORS) as SpecialistRole[]) {
    for (const [domain, score] of Object.entries(DEFAULT_PRIORS[specialist])) {
      scores.push({
        specialist,
        domain: domain as CompetenceDomain,
        score: score!,
        sampleCount: 0,
        lastUpdated: now,
      });
    }
  }
  return scores;
}

/**
 * Returns the best specialist for a domain using stored scores, falling back to
 * priors when no project profile exists.
 */
export function recommendSpecialist(
  domain: CompetenceDomain,
  scores: CompetenceScore[],
): SpecialistRole {
  const candidates = scores.filter(s => s.domain === domain);
  if (candidates.length === 0) {
    const fallback = (Object.entries(PRIMARY_DOMAIN) as [SpecialistRole, CompetenceDomain][])
      .find(([, d]) => d === domain);
    if (fallback) return fallback[0];
    return 'coder';
  }
  const best = candidates.reduce((a, b) => (a.score >= b.score ? a : b));
  return best.specialist;
}

/**
 * Exponential moving average update for one (specialist, domain) pair.
 * `alpha` controls learning rate (higher = more weight on latest outcome).
 */
export function applyOutcome(
  scores: CompetenceScore[],
  outcome: StepOutcome,
  alpha = 0.15,
): CompetenceScore[] {
  const signal = outcome.success
    ? clamp01(outcome.quality ?? 1)
    : clamp01((outcome.quality ?? 0) * 0.25);
  const now = Date.now();
  const k = key(outcome.specialist, outcome.domain);
  const idx = scores.findIndex(s => key(s.specialist, s.domain) === k);

  if (idx < 0) {
    const prior = DEFAULT_PRIORS[outcome.specialist]?.[outcome.domain] ?? 0.5;
    return [
      ...scores,
      {
        specialist: outcome.specialist,
        domain: outcome.domain,
        score: clamp01((1 - alpha) * prior + alpha * signal),
        sampleCount: 1,
        lastUpdated: now,
      },
    ];
  }

  const cur = scores[idx];
  const next: CompetenceScore = {
    ...cur,
    score: clamp01((1 - alpha) * cur.score + alpha * signal),
    sampleCount: cur.sampleCount + 1,
    lastUpdated: now,
  };
  return [...scores.slice(0, idx), next, ...scores.slice(idx + 1)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — {projectRoot}/.aura/competence.json
// ─────────────────────────────────────────────────────────────────────────────

export const competenceStore = {
  filePath(projectRoot: string): string {
    return path.join(projectRoot, '.aura', 'competence.json');
  },

  async load(projectRoot: string): Promise<ProjectCompetence> {
    const filePath = this.filePath(projectRoot);
    if (!fs.existsSync(filePath)) {
      return {
        projectRoot,
        scores: defaultCompetenceMatrix(),
        version: 1,
      };
    }
    const raw = await fs.promises.readFile(filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw) as ProjectCompetence;
      if (parsed?.version === 1 && Array.isArray(parsed.scores)) {
        return parsed;
      }
    } catch {
      /* fall through */
    }
    return {
      projectRoot,
      scores: defaultCompetenceMatrix(),
      version: 1,
    };
  },

  async save(profile: ProjectCompetence): Promise<void> {
    const filePath = this.filePath(profile.projectRoot);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(profile, null, 2), 'utf8');
    await fs.promises.rename(tmp, filePath);
  },

  async recordOutcome(projectRoot: string, outcome: StepOutcome): Promise<ProjectCompetence> {
    const profile = await this.load(projectRoot);
    const updated: ProjectCompetence = {
      ...profile,
      scores: applyOutcome(profile.scores, outcome),
    };
    await this.save(updated);
    return updated;
  },
};