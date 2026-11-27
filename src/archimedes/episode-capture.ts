import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { Episode } from './types.js';
import { shouldFineTune } from './competence.js';

// ─────────────────────────────────────────────────────────────────────────────
// Episode persistence
// ─────────────────────────────────────────────────────────────────────────────
//
// Stores alternation episodes under ~/.aura/episodes/{projectHash}/ so
// Archimedes competence and fine-tune readiness can be computed per project.

/** Stats returned by {@link getEpisodeStats}. */
export interface EpisodeStats {
  total: number;
  archimedesSuccesses: number;
  archimedesFailures: number;
  largeModelInterventions: number;
  readyForFineTune: boolean;
}

/**
 * On-disk episode persistence for the Archimedes Principle.
 * Mirrors {@link sessionStore} — atomic `.tmp` writes, namespaced by project hash.
 */
export const episodeStore = {
  defaultDir(): string {
    // AURA_EPISODES_DIR: harnesses (benchmark/escalation) isolate runs into a
    // scratch dir so synthetic episodes never pollute live competence data.
    return process.env.AURA_EPISODES_DIR
      ?? path.join(process.env.HOME ?? '/tmp', '.aura', 'episodes');
  },

  /**
   * Stable per-project namespace: the first 16 hex characters of SHA-256.
   *
   * The old implementation took the first 8 characters of the path's base64
   * encoding. That is a prefix, not a hash, so every path starting with the
   * same 6 bytes collided — all `/mnt/bigdata/...` projects shared one
   * directory and pooled their competence data.
   */
  projectHash(projectRoot: string): string {
    return createHash('sha256').update(projectRoot, 'utf8').digest('hex').slice(0, 16);
  },

  /**
   * The pre-fix directory name (first 8 base64 characters). Kept read-only so
   * existing episode history is not lost; new writes always use projectHash().
   */
  legacyProjectHash(projectRoot: string): string {
    return Buffer.from(projectRoot, 'utf8').toString('base64').slice(0, 8);
  },

  /** Directory containing all episodes for a project. */
  projectDir(projectRoot: string): string {
    return path.join(this.defaultDir(), this.projectHash(projectRoot));
  },

  /** Old, collision-prone episode directory for a project. */
  legacyProjectDir(projectRoot: string): string {
    return path.join(this.defaultDir(), this.legacyProjectHash(projectRoot));
  },

  /** Full path to one episode file. */
  episodePath(projectRoot: string, id: string): string {
    return path.join(this.projectDir(projectRoot), `${id}.json`);
  },

  /**
   * Persists one episode to `~/.aura/episodes/{projectHash}/{id}.json`.
   */
  async saveEpisode(projectRoot: string, episode: Episode): Promise<void> {
    const dir = this.projectDir(projectRoot);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = this.episodePath(projectRoot, episode.id);
    const tmp = filePath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(episode, null, 2), 'utf8');
    await fs.promises.rename(tmp, filePath);
  },

  /**
   * Loads episodes for a project, newest first.
   *
   * Reads the new SHA-256 directory, then the old base64-prefix directory.
   * Legacy entries are admitted only when their `projectRoot` matches exactly,
   * because several projects used to share one legacy directory; entries
   * written before `projectRoot` was recorded cannot be attributed safely and
   * are skipped rather than assigned to the wrong project.
   *
   * Never throws — returns `[]` on missing dir or parse errors.
   */
  loadEpisodesSync(projectRoot: string, limit?: number): Episode[] {
    const readDir = (dir: string, requireProjectRoot: boolean): Episode[] => {
      if (!fs.existsSync(dir)) return [];
      const episodes: Episode[] = [];
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Episode;
          if (!parsed?.id || typeof parsed.timestamp !== 'number') continue;
          if (requireProjectRoot && path.normalize(parsed.projectRoot ?? '') !== path.normalize(projectRoot)) {
            continue;
          }
          episodes.push(parsed);
        } catch {
          /* skip corrupt file */
        }
      }
      return episodes;
    };

    try {
      const byId = new Map<string, Episode>();
      // Current namespace wins over a legacy duplicate of the same episode.
      for (const ep of readDir(this.projectDir(projectRoot), false)) byId.set(ep.id, ep);
      for (const ep of readDir(this.legacyProjectDir(projectRoot), true)) {
        if (!byId.has(ep.id)) byId.set(ep.id, ep);
      }

      const episodes = [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
      if (limit !== undefined && limit > 0) return episodes.slice(0, limit);
      return episodes;
    } catch {
      return [];
    }
  },

  async loadEpisodes(projectRoot: string, limit?: number): Promise<Episode[]> {
    return this.loadEpisodesSync(projectRoot, limit);
  },

  /**
   * Removes one episode file. Safe when the file does not exist.
   */
  async deleteEpisode(projectRoot: string, id: string): Promise<void> {
    const filePath = this.episodePath(projectRoot, id);
    if (!fs.existsSync(filePath)) return;
    await fs.promises.unlink(filePath);
  },

  /**
   * Aggregates episode counters and fine-tune readiness for a project.
   * Never throws — returns zeroed stats on error.
   */
  async getEpisodeStats(projectRoot: string): Promise<EpisodeStats> {
    try {
      const episodes = await this.loadEpisodes(projectRoot);
      let archimedesSuccesses = 0;
      let archimedesFailures = 0;
      let largeModelInterventions = 0;

      for (const ep of episodes) {
        if (ep.archimedesAttempted) {
          if (ep.archimedesSucceeded) archimedesSuccesses++;
          else archimedesFailures++;
        }
        if (ep.largeModelUsed) largeModelInterventions++;
      }

      return {
        total: episodes.length,
        archimedesSuccesses,
        archimedesFailures,
        largeModelInterventions,
        readyForFineTune: shouldFineTune(episodes),
      };
    } catch {
      return {
        total: 0,
        archimedesSuccesses: 0,
        archimedesFailures: 0,
        largeModelInterventions: 0,
        readyForFineTune: false,
      };
    }
  },
};

// Named re-exports (callers may import functions directly)
export const saveEpisode = episodeStore.saveEpisode.bind(episodeStore);
export const loadEpisodes = episodeStore.loadEpisodes.bind(episodeStore);
export const loadEpisodesSync = episodeStore.loadEpisodesSync.bind(episodeStore);
export const deleteEpisode = episodeStore.deleteEpisode.bind(episodeStore);
export const getEpisodeStats = episodeStore.getEpisodeStats.bind(episodeStore);