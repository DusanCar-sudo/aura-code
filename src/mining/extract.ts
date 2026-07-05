import { loadEpisodes } from '../ruby/episode-capture.js';
import type { Episode, TaskCategory } from '../ruby/types.js';

/**
 * Baby Ruby — experience mining, not learning.
 *
 * Finds structure in raw episode data using pure statistics: clustering,
 * frequency counts, keyword overlap. NO LLM calls. This is deliberate:
 * Baby Ruby's job is to be reliable, boring infrastructure — the kind that
 * doesn't hallucinate, doesn't cost tokens, and produces the same output
 * given the same input every time.
 *
 * This is the "observation" stage of a three-stage cognitive pipeline:
 *
 *   episodes (raw experience)
 *     -> Baby Ruby (this file)    — no LLM, finds structure
 *       -> concepts (this file's output)
 *         -> Papa Ruby (future)   — local LLM, reasons about concepts
 *           -> training data / refined knowledge
 *
 * Baby Ruby does NOT produce instruction/output training pairs. That is
 * explicitly Papa Ruby's job, on top of Baby Ruby's structure. Keeping this
 * separation means Baby Ruby never needs a model, a provider, an API key,
 * or a network call — it's pure, fast, and always available.
 *
 * Three-pass recursive clustering:
 *   Pass 1 — broad clusters by taskCategory (research/implementation/
 *            review/refactor/other). This is free — the category already
 *            exists on every episode.
 *   Pass 2 — sub-clusters within each category by keyword overlap (shared
 *            significant words in task text, e.g. "auth", "type", "test").
 *   Pass 3 — extract stable concepts from sub-clusters that meet a minimum
 *            size and produce a confidence score.
 *
 * Termination condition (real, not infinite recursion):
 *   Recursion stops when a sub-cluster pass finds no split that produces
 *   two groups each above MIN_CLUSTER_SIZE, OR when MAX_DEPTH is reached.
 *   This is a depth-bounded, size-bounded recursion — it always halts.
 */

const MIN_CLUSTER_SIZE = 3;
const MAX_DEPTH = 3;
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for',
  'of', 'and', 'or', 'but', 'this', 'that', 'with', 'it', 'as', 'be', 'by',
  'from', 'has', 'have', 'had', 'do', 'does', 'did', 'not', 'no', 'so', 'if',
  'then', 'there', 'here', 'what', 'when', 'where', 'how', 'why', 'which',
  'who', 'will', 'would', 'can', 'could', 'should', 'i', 'you', 'we', 'they',
  'my', 'your', 'our', 'their', 'me', 'us', 'them',
]);

export interface MinedConcept {
  /** Short slug-like identifier for the concept (e.g. "verification_before_completion"). */
  concept: string;
  /** Category this concept was mined from. */
  category: TaskCategory;
  /** Representative example task strings from the cluster (max 5, shortest first). */
  examples: string[];
  /** Number of episodes that contributed to this concept. */
  frequency: number;
  /** Mechanical confidence: cluster cohesion combined with cluster size relative to total. */
  confidence: number;
  /** Depth at which this concept was extracted (1, 2, or 3). */
  depth: number;
  /** The shared keywords that define this cluster. */
  keywords: string[];
}

export interface MiningResult {
  concepts: MinedConcept[];
  episodeCount: number;
  /** Episodes that didn't cluster into anything meaningful — too rare or too unique. */
  unclustered: number;
}

interface ClusterNode {
  episodes: Episode[];
  keywords: string[];
  depth: number;
}

/** Extract significant (non-stopword, length > 2) lowercase words from task text. */
function significantWords(task: string): string[] {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/** Jaccard-style overlap between two word sets, in [0, 1]. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Group episodes by shared keywords using a simple greedy clustering pass.
 * Not k-means, not embeddings — deliberately simple, deterministic, fast.
 * Each episode joins the first existing cluster it overlaps with above
 * OVERLAP_THRESHOLD; otherwise it starts a new cluster.
 */
const OVERLAP_THRESHOLD = 0.15;

function clusterByKeywords(episodes: Episode[]): ClusterNode[] {
  const wordSets = episodes.map(e => new Set(significantWords(e.task)));
  const clusters: { episodes: Episode[]; wordSets: Set<string>[] }[] = [];

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const words = wordSets[i];
    let placed = false;

    for (const cluster of clusters) {
      // Compare against the cluster's combined word set (union of members so far).
      const clusterWords = new Set<string>();
      for (const ws of cluster.wordSets) for (const w of ws) clusterWords.add(w);
      if (overlap(words, clusterWords) >= OVERLAP_THRESHOLD) {
        cluster.episodes.push(ep);
        cluster.wordSets.push(words);
        placed = true;
        break;
      }
    }

    if (!placed) {
      clusters.push({ episodes: [ep], wordSets: [words] });
    }
  }

  return clusters
    .filter(c => c.episodes.length >= MIN_CLUSTER_SIZE)
    .map(c => {
      // Find the words shared by the most members — the cluster's defining keywords.
      const counts = new Map<string, number>();
      for (const ws of c.wordSets) for (const w of ws) counts.set(w, (counts.get(w) ?? 0) + 1);
      const keywords = [...counts.entries()]
        .filter(([, count]) => count >= Math.max(2, Math.ceil(c.episodes.length * 0.4)))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([w]) => w);
      return { episodes: c.episodes, keywords, depth: 0 };
    });
}

/**
 * Compute keywords for a leaf node that won't be split further — either
 * because it hit MAX_DEPTH, or because it's too small to split into two
 * valid sub-clusters. Without this, small categories (3-5 episodes) would
 * surface as a "concept" with empty keywords, which is meaningless: a bare
 * category label isn't a concept on its own.
 */
function leafKeywords(episodes: Episode[]): string[] {
  const counts = new Map<string, number>();
  for (const ep of episodes) {
    for (const w of new Set(significantWords(ep.task))) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= Math.max(2, Math.ceil(episodes.length * 0.4)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w);
}

function recursiveSplit(node: ClusterNode): ClusterNode[] {
  if (node.depth >= MAX_DEPTH) {
    return [{ ...node, keywords: node.keywords.length > 0 ? node.keywords : leafKeywords(node.episodes) }];
  }
  if (node.episodes.length < MIN_CLUSTER_SIZE * 2) {
    // Too small to split into two valid clusters — still compute keywords
    // so this leaf carries real structure instead of an empty label.
    return [{ ...node, keywords: node.keywords.length > 0 ? node.keywords : leafKeywords(node.episodes) }];
  }

  const subClusters = clusterByKeywords(node.episodes);

  // No real split: either zero sub-clusters formed, or exactly one sub-cluster
  // that contains essentially all the same episodes (no new structure found).
  const isRealSplit = subClusters.length >= 2 ||
    (subClusters.length === 1 && subClusters[0].episodes.length < node.episodes.length);

  if (!isRealSplit) {
    return [{ ...node, keywords: node.keywords.length > 0 ? node.keywords : leafKeywords(node.episodes) }];
  }

  const deepened = subClusters.map(c => ({ ...c, depth: node.depth + 1 }));
  return deepened.flatMap(recursiveSplit);
}

/** Mechanical confidence: cluster cohesion (size) weighted against the total episode pool. */
function computeConfidence(clusterSize: number, totalEpisodes: number, depth: number): number {
  const sizeRatio = totalEpisodes > 0 ? clusterSize / totalEpisodes : 0;
  // Deeper clusters are more specific — slightly boost confidence for depth,
  // since a stable pattern surviving 2-3 splits is more meaningful than a
  // broad depth-1 cluster that's just "all coding tasks."
  const depthBonus = Math.min(depth * 0.05, 0.15);
  const raw = Math.min(1, sizeRatio * 3 + depthBonus); // *3 so e.g. 17/100 episodes -> 0.51+bonus, not 0.17
  return Math.round(raw * 100) / 100;
}

function slugifyConcept(keywords: string[], category: TaskCategory): string {
  const base = keywords.length > 0 ? keywords.slice(0, 3).join('_') : category;
  return base.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function leafToConcept(leaf: ClusterNode, category: TaskCategory, totalEpisodes: number): MinedConcept {
  const sorted = [...leaf.episodes].sort((a, b) => a.task.length - b.task.length);
  const examples = sorted.slice(0, 5).map(e => e.task.slice(0, 140));
  return {
    concept: slugifyConcept(leaf.keywords, category),
    category,
    examples,
    frequency: leaf.episodes.length,
    confidence: computeConfidence(leaf.episodes.length, totalEpisodes, leaf.depth),
    depth: Math.max(1, leaf.depth),
    keywords: leaf.keywords,
  };
}

/**
 * Run Baby Ruby: mine episodes for structural patterns without any LLM call.
 *
 * Pass 1: group by taskCategory (free, already on every episode).
 * Pass 2-3: within each category, recursively split by keyword overlap
 *           until no meaningful further split exists or MAX_DEPTH is hit.
 *
 * Returns a flat list of MinedConcept — Papa Ruby (future) will read these
 * and turn the most useful ones into actual training/instruction data.
 */
export async function mineExperience(projectRoot: string): Promise<MiningResult> {
  const episodes = await loadEpisodes(projectRoot);

  if (episodes.length === 0) {
    return { concepts: [], episodeCount: 0, unclustered: 0 };
  }

  // Pass 1: broad clusters by category — always free, no clustering needed.
  const byCategory = new Map<TaskCategory, Episode[]>();
  for (const ep of episodes) {
    const list = byCategory.get(ep.taskCategory) ?? [];
    list.push(ep);
    byCategory.set(ep.taskCategory, list);
  }

  const allConcepts: MinedConcept[] = [];
  let clusteredCount = 0;

  for (const [category, categoryEpisodes] of byCategory) {
    if (categoryEpisodes.length < MIN_CLUSTER_SIZE) continue; // too rare to mine

    // Pass 2-3: recursive keyword splitting within this category.
    const initialNode: ClusterNode = { episodes: categoryEpisodes, keywords: [], depth: 0 };
    const leaves = recursiveSplit(initialNode);

    for (const leaf of leaves) {
      if (leaf.episodes.length < MIN_CLUSTER_SIZE) continue;
      allConcepts.push(leafToConcept(leaf, category, episodes.length));
      clusteredCount += leaf.episodes.length;
    }
  }

  // Sort by confidence descending — most stable/significant concepts first.
  allConcepts.sort((a, b) => b.confidence - a.confidence);

  return {
    concepts: allConcepts,
    episodeCount: episodes.length,
    unclustered: episodes.length - clusteredCount,
  };
}
