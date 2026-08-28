import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Training-data corpus inspection (Task 4 of the repair plan)
//
// :mine --stats reports how many rows exist in training-data/*.jsonl and how
// they split by provenance ("mined" | "correction"). This is the survival check
// for the tag the plan requires: if the provenance field is lost anywhere in
// the pipeline, this file is where it shows up first.
// ─────────────────────────────────────────────────────────────────────────────

export interface CorpusStats {
  /** Total rows across all jsonl files in training-data/. */
  total: number;
  /** Row count per provenance value (only provenances present). */
  byProvenance: Record<string, number>;
  /** Number of jsonl files inspected. */
  files: number;
  /** Paths of the files scanned. */
  filePaths: string[];
}

function trainingDataDir(projectRoot: string): string {
  return path.join(projectRoot, 'training-data');
}

/**
 * Count TrainingExample rows in every training-data/<date>.jsonl under
 * projectRoot, and group them by metadata.provenance.
 * Never throws — returns an empty corpus on missing dir / unreadable / malformed rows.
 */
export function trainingDataStats(projectRoot: string): CorpusStats {
  const dir = trainingDataDir(projectRoot);
  const stats: CorpusStats = { total: 0, byProvenance: {}, files: 0, filePaths: [] };
  let files: string[] = [];
  try {
    if (!fs.existsSync(dir)) return stats;
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return stats;
  }
  for (const f of files) {
    const filePath = path.join(dir, f);
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const row = JSON.parse(line) as { metadata?: { provenance?: string } };
          const prov = row.metadata?.provenance ?? 'unknown';
          stats.byProvenance[prov] = (stats.byProvenance[prov] ?? 0) + 1;
          stats.total++;
        } catch {
          /* skip malformed row */
        }
      }
      stats.files++;
      stats.filePaths.push(filePath);
    } catch {
      /* skip unreadable file */
    }
  }
  return stats;
}
