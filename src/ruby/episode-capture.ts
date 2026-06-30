import * as fs from 'fs';
import * as path from 'path';
import type { Episode } from './types.js';
import { shouldFineTune } from './competence.js';

// ─────────────────────────────────────────────────────────────────────────────
// Episode persistence
// ─────────────────────────────────────────────────────────────────────────────
//
// Stores alternation episodes under ~/.aura/episodes/{projectHash}/ so
// Ruby competence and fine-tune readiness can be computed per project.

/** Stats returned by {@link getEpisodeStats}. */
export interface EpisodeStats {
  total: number;
  rubySuccesses: number;
  rubyFailures: number;
  largeModelInterventions: number;
  readyForFineTune: boolean;
}

/**
 * On-disk episode persistence for the Ruby Principle.
 * Mirrors {@link sessionStore} — atomic `.tmp` writes, namespaced by project hash.
 */
export const episodeStore = {
  defaultDir(): string {
    return path.join(process.env.HOME ?? '/tmp', '.aura', 'episodes');
  },

  /**
   * First 8 characters of the base64 encoding of `projectRoot`.
   */
  projectHash(projectRoot: string): string {
    return Buffer.from(projectRoot, 'utf8').toString('base64').slice(0, 8);
  },

  /** Directory containing all episodes for a project. */
  projectDir(projectRoot: string): string {
    return path.join(this.defaultDir(), this.projectHash(projectRoot));
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
   * Never throws — returns `[]` on missing dir or parse errors.
   */
  async loadEpisodes(projectRoot: string, limit?: number): Promise<Episode[]> {
    try {
      const dir = this.projectDir(projectRoot);
      if (!fs.existsSync(dir)) return [];

      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      const episodes: Episode[] = [];

      for (const file of files) {
        const raw = await fs.promises.readFile(path.join(dir, file), 'utf8');
        try {
          const parsed = JSON.parse(raw) as Episode;
          if (parsed?.id && typeof parsed.timestamp === 'number') {
            episodes.push(parsed);
          }
        } catch {
          /* skip corrupt file */
        }
      }

      episodes.sort((a, b) => b.timestamp - a.timestamp);
      if (limit !== undefined && limit > 0) {
        return episodes.slice(0, limit);
      }
      return episodes;
    } catch {
      return [];
    }
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
      let rubySuccesses = 0;
      let rubyFailures = 0;
      let largeModelInterventions = 0;

      for (const ep of episodes) {
        if (ep.rubyAttempted) {
          if (ep.rubySucceeded) rubySuccesses++;
          else rubyFailures++;
        }
        if (ep.largeModelUsed) largeModelInterventions++;
      }

      return {
        total: episodes.length,
        rubySuccesses,
        rubyFailures,
        largeModelInterventions,
        readyForFineTune: shouldFineTune(episodes),
      };
    } catch {
      return {
        total: 0,
        rubySuccesses: 0,
        rubyFailures: 0,
        largeModelInterventions: 0,
        readyForFineTune: false,
      };
    }
  },
};

// Named re-exports (callers may import functions directly)
export const saveEpisode = episodeStore.saveEpisode.bind(episodeStore);
export const loadEpisodes = episodeStore.loadEpisodes.bind(episodeStore);
export const deleteEpisode = episodeStore.deleteEpisode.bind(episodeStore);
export const getEpisodeStats = episodeStore.getEpisodeStats.bind(episodeStore);