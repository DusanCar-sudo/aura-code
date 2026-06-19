import type { Episode } from './types.js';
import { episodeStore } from './episode-capture.js';

// ─────────────────────────────────────────────────────────────────────────────
// Model selection from episode history
// ─────────────────────────────────────────────────────────────────────────────

const MIN_EPISODES_FOR_SELECTION = 5;

/**
 * Tokenises a task string into lowercase words (≥3 chars).
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

/**
 * Simple Jaccard similarity between two task strings.
 */
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

/**
 * Given a list of past episodes and the current task, selects the model that
 * has historically performed best (highest approval rate, then highest task
 * count) on similar tasks. Returns `undefined` when there is insufficient
 * history or no clear winner.
 *
 * Only considers episodes where `largeModelUsed` is set.
 * Never throws.
 */
export function selectModelFromHistory(
  episodes: Episode[],
  task: string,
  availableModels: string[],
): string | undefined {
  try {
    if (!Array.isArray(episodes) || episodes.length < MIN_EPISODES_FOR_SELECTION) {
      return undefined;
    }
    if (!availableModels || availableModels.length === 0) {
      return undefined;
    }

    // Weight similar episodes higher; include all episodes with at least some weight
    const SIMILARITY_THRESHOLD = 0.15;

    interface ModelAccum {
      weightedApprovals: number;
      weight: number;
      tasks: number;
    }
    const modelStats = new Map<string, ModelAccum>();

    for (const ep of episodes) {
      if (!ep.largeModelUsed) continue;
      // Only consider models that are in the available set
      if (!availableModels.includes(ep.largeModelUsed)) continue;

      const sim = similarity(task, ep.task);
      const weight = sim >= SIMILARITY_THRESHOLD ? 1 + sim : 0.1;

      const prev = modelStats.get(ep.largeModelUsed) ?? {
        weightedApprovals: 0,
        weight: 0,
        tasks: 0,
      };
      prev.weight += weight;
      prev.weightedApprovals += ep.reviewerApproved ? weight : 0;
      prev.tasks += 1;
      modelStats.set(ep.largeModelUsed, prev);
    }

    if (modelStats.size === 0) return undefined;

    // Compute weighted approval rate per model
    const ranked = Array.from(modelStats.entries())
      .map(([model, s]) => ({
        model,
        approvalRate: s.weight === 0 ? 0 : s.weightedApprovals / s.weight,
        tasks: s.tasks,
      }))
      .sort((a, b) => {
        const rateDiff = b.approvalRate - a.approvalRate;
        if (Math.abs(rateDiff) > 0.05) return rateDiff;
        return b.tasks - a.tasks;
      });

    return ranked[0]?.model;
  } catch {
    return undefined;
  }
}

/**
 * Loads episodes from disk and calls `selectModelFromHistory`.
 * Returns `undefined` when there are fewer than 5 episodes or on any error.
 *
 * @param projectRoot - Absolute project root path.
 * @param task - Current task description.
 * @param availableModels - Models that can actually be used (e.g. from getAllModels()).
 */
export async function selectModel(
  projectRoot: string,
  task: string,
  availableModels: string[],
): Promise<string | undefined> {
  try {
    const episodes = await episodeStore.loadEpisodes(projectRoot);
    if (episodes.length < MIN_EPISODES_FOR_SELECTION) return undefined;
    return selectModelFromHistory(episodes, task, availableModels);
  } catch {
    return undefined;
  }
}
