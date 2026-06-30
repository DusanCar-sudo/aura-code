import type {
  AlternationDecision,
  CompetenceLevel,
  Episode,
  RubyConfig,
} from './types.js';
import { DEFAULT_RUBY_CONFIG } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Large model used when Ruby is not trusted or is disabled. */
export const DEFAULT_FALLBACK_MODEL = 'claude-sonnet-4-5-20251001';

/** Default failure count before `shouldFineTune` returns true. */
export const DEFAULT_MIN_FAILURES = 20;

/** Maximum exemplars kept per competence pattern. */
const MAX_EXAMPLES = 10;

/** Minimum token-overlap ratio to treat two tasks as similar. */
const SIMILARITY_THRESHOLD = 0.35;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers (pure, no I/O)
// ─────────────────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function safeConfig(config: RubyConfig): RubyConfig {
  return {
    modelName: config?.modelName ?? DEFAULT_RUBY_CONFIG.modelName,
    ollamaBaseUrl: config?.ollamaBaseUrl ?? DEFAULT_RUBY_CONFIG.ollamaBaseUrl,
    competenceThreshold: clamp01(
      config?.competenceThreshold ?? DEFAULT_RUBY_CONFIG.competenceThreshold,
    ),
    minAttempts: Math.max(0, config?.minAttempts ?? DEFAULT_RUBY_CONFIG.minAttempts),
    enabled: config?.enabled ?? DEFAULT_RUBY_CONFIG.enabled,
  };
}

function tokenize(text: string): string[] {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tasksSimilar(task: string, other: string): boolean {
  const na = task.trim().toLowerCase();
  const nb = other.trim().toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return similarity(na, nb) >= SIMILARITY_THRESHOLD;
}

/**
 * Derives a stable pattern key from a task string and optional category.
 */
function taskPatternFrom(task: string, category?: string): string {
  const tokens = tokenize(task).slice(0, 8);
  const slug = tokens.join('_') || 'generic';
  const cat = category ?? 'other';
  return `${cat}:${slug}`;
}

function safeEpisodes(episodes: Episode[]): Episode[] {
  if (!Array.isArray(episodes)) return [];
  return episodes.filter(
    e => e && typeof e.task === 'string' && typeof e.rubyAttempted === 'boolean',
  );
}

function buildLevelFromEpisodes(
  pattern: string,
  matched: Episode[],
): CompetenceLevel {
  const attempted = matched.filter(e => e.rubyAttempted);
  const successes = attempted.filter(e => e.rubySucceeded);
  const attemptCount = attempted.length;
  const successRate = attemptCount === 0 ? 0 : successes.length / attemptCount;
  const examples = attempted
    .slice(-MAX_EXAMPLES)
    .map(e => ({ task: e.task, succeeded: e.rubySucceeded }));
  const lastUpdated = attempted.reduce(
    (max, e) => Math.max(max, e.timestamp ?? 0),
    0,
  );
  return {
    taskPattern: pattern,
    successRate: clamp01(successRate),
    attemptCount,
    lastUpdated: lastUpdated || Date.now(),
    examples,
  };
}

function safeDecision(partial: Partial<AlternationDecision>): AlternationDecision {
  return {
    useRuby: partial.useRuby ?? true,
    reason: partial.reason ?? 'Defaulting to Ruby (safe fallback).',
    confidence: clamp01(partial.confidence ?? 0),
    competenceLevel: partial.competenceLevel,
    fallbackModel: partial.fallbackModel ?? DEFAULT_FALLBACK_MODEL,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// assessCompetence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decides whether the current task should be routed to Ruby or escalated to
 * the large model, based on historical episodes and configuration thresholds.
 *
 * Never throws — returns a conservative `AlternationDecision` on bad input.
 */
export function assessCompetence(
  episodes: Episode[],
  task: string,
  config: RubyConfig,
): AlternationDecision {
  try {
    const cfg = safeConfig(config);
    const fallbackModel = DEFAULT_FALLBACK_MODEL;

    if (!cfg.enabled) {
      return safeDecision({
        useRuby: false,
        reason: 'Ruby alternation is disabled in configuration.',
        confidence: 1,
        fallbackModel,
      });
    }

    const safeTask = typeof task === 'string' ? task : '';
    const list = safeEpisodes(episodes);
    const matched = list.filter(e => tasksSimilar(safeTask, e.task));
    const pattern = taskPatternFrom(
      safeTask,
      matched[0]?.taskCategory ?? 'other',
    );
    const level = buildLevelFromEpisodes(pattern, matched);

    if (level.attemptCount < cfg.minAttempts) {
      return safeDecision({
        useRuby: true,
        reason: `Only ${level.attemptCount} prior attempt(s) for this pattern (minimum ${cfg.minAttempts}) — giving Ruby a chance to learn.`,
        confidence: clamp01(0.3 + level.attemptCount / Math.max(cfg.minAttempts, 1) * 0.3),
        competenceLevel: level,
        fallbackModel,
      });
    }

    if (level.successRate >= cfg.competenceThreshold) {
      return safeDecision({
        useRuby: true,
        reason: `Ruby success rate ${(level.successRate * 100).toFixed(0)}% meets threshold ${(cfg.competenceThreshold * 100).toFixed(0)}% for pattern "${pattern}".`,
        confidence: clamp01(level.successRate * Math.min(1, level.attemptCount / 10)),
        competenceLevel: level,
        fallbackModel,
      });
    }

    return safeDecision({
      useRuby: false,
      reason: `Ruby success rate ${(level.successRate * 100).toFixed(0)}% below threshold ${(cfg.competenceThreshold * 100).toFixed(0)}% after ${level.attemptCount} attempt(s) — escalating to large model.`,
      confidence: clamp01((1 - level.successRate) * Math.min(1, level.attemptCount / 10)),
      competenceLevel: level,
      fallbackModel,
    });
  } catch {
    return safeDecision({
      useRuby: true,
      reason: 'Assessment error — defaulting to Ruby attempt.',
      confidence: 0,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// updateCompetence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merges one completed episode into the competence map.
 * Never throws — returns the previous list unchanged on invalid input.
 */
export function updateCompetence(
  existing: CompetenceLevel[],
  episode: Episode,
): CompetenceLevel[] {
  try {
    if (!episode?.rubyAttempted) return Array.isArray(existing) ? [...existing] : [];

    const list = Array.isArray(existing) ? [...existing] : [];
    const pattern = taskPatternFrom(episode.task ?? '', episode.taskCategory);
    const idx = list.findIndex(l => l.taskPattern === pattern);
    const prev = idx >= 0 ? list[idx] : undefined;

    const examples = [
      ...(prev?.examples ?? []),
      { task: episode.task, succeeded: episode.rubySucceeded },
    ].slice(-MAX_EXAMPLES);

    const attemptCount = (prev?.attemptCount ?? 0) + 1;
    const prevSuccesses = Math.round((prev?.successRate ?? 0) * (prev?.attemptCount ?? 0));
    const newSuccesses = prevSuccesses + (episode.rubySucceeded ? 1 : 0);
    const successRate = attemptCount === 0 ? 0 : newSuccesses / attemptCount;

    const updated: CompetenceLevel = {
      taskPattern: pattern,
      successRate: clamp01(successRate),
      attemptCount,
      lastUpdated: episode.timestamp ?? Date.now(),
      examples,
    };

    if (idx >= 0) {
      list[idx] = updated;
      return list;
    }
    return [...list, updated];
  } catch {
    return Array.isArray(existing) ? [...existing] : [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getCompetenceReport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Summarises Ruby performance grouped by `taskCategory`.
 * Never throws — returns an empty array on invalid input.
 */
export function getCompetenceReport(
  episodes: Episode[],
): { category: string; successRate: number; count: number }[] {
  try {
    const list = safeEpisodes(episodes);
    const buckets = new Map<string, { successes: number; count: number }>();

    for (const ep of list) {
      if (!ep.rubyAttempted) continue;
      const cat = ep.taskCategory ?? 'other';
      const b = buckets.get(cat) ?? { successes: 0, count: 0 };
      b.count += 1;
      if (ep.rubySucceeded) b.successes += 1;
      buckets.set(cat, b);
    }

    return Array.from(buckets.entries())
      .map(([category, { successes, count }]) => ({
        category,
        successRate: clamp01(count === 0 ? 0 : successes / count),
        count,
      }))
      .sort((a, b) => b.count - a.count);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// shouldFineTune
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when enough Ruby failures have accumulated to justify a
 * fine-tune pass. A failure is an episode where Ruby was attempted but did
 * not succeed (large model intervened or reviewer rejected).
 *
 * Never throws — returns false on invalid input.
 */
export function shouldFineTune(
  episodes: Episode[],
  minFailures: number = DEFAULT_MIN_FAILURES,
): boolean {
  try {
    const threshold = Math.max(1, minFailures ?? DEFAULT_MIN_FAILURES);
    const list = safeEpisodes(episodes);
    const failures = list.filter(
      e => e.rubyAttempted && !e.rubySucceeded,
    ).length;
    return failures >= threshold;
  } catch {
    return false;
  }
}