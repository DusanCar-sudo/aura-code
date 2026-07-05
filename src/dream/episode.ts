/**
 * Episode — layer 1 of the memory loop (see MEMORY.md).
 * Auto-recorded, zero LLM calls. Atomic .tmp+rename write, namespaced
 * per project by a hash of its root path.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface Episode {
  id: string;
  timestamp: number;
  task: string;
  model: string;
  success: boolean;
  tokens: number;
  durationMs: number;
}

function projectHash(root: string): string {
  return crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12);
}

function episodesDir(root: string): string {
  return path.join(os.homedir(), '.aura', 'episodes', projectHash(root));
}

/** Record one episode. Best-effort — never throws into the caller's task flow. */
export function recordEpisode(root: string, ep: Omit<Episode, 'id' | 'timestamp'>): void {
  try {
    const dir = episodesDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const full: Episode = { id, timestamp: Date.now(), ...ep };
    const finalPath = path.join(dir, `${id}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(full, null, 2));
    fs.renameSync(tmpPath, finalPath);
  } catch {
    // Episodic memory is best-effort — never let it break a task.
  }
}

/** All episodes for a project, oldest first. */
export function listEpisodes(root: string): Episode[] {
  const dir = episodesDir(root);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const episodes: Episode[] = [];
  for (const f of files) {
    try {
      episodes.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch { /* skip corrupt entries */ }
  }
  return episodes.sort((a, b) => a.timestamp - b.timestamp);
}

/** Episodes newer than a given timestamp (used for "since last dream"). */
export function listEpisodesSince(root: string, sinceMs: number): Episode[] {
  return listEpisodes(root).filter(e => e.timestamp > sinceMs);
}

/** All episodes across EVERY project (used for the global lessons digest). */
export function listAllEpisodes(): Episode[] {
  const base = path.join(os.homedir(), '.aura', 'episodes');
  if (!fs.existsSync(base)) return [];
  const episodes: Episode[] = [];
  for (const proj of fs.readdirSync(base)) {
    const dir = path.join(base, proj);
    let files: string[];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch { continue; }
    for (const f of files) {
      try {
        episodes.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch { /* skip corrupt entries */ }
    }
  }
  return episodes.sort((a, b) => a.timestamp - b.timestamp);
}
