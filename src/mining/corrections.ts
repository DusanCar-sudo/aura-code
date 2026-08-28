import * as fs from 'fs';
import * as path from 'path';
import { loadEpisodes } from '../archimedes/episode-capture.js';
import type { Episode, TrainingExample } from '../archimedes/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Path B — direct correction pairs (Task 4 of the repair plan)
//
// Path A (existing, src/mining/refine.ts) does statistical clustering and
// asks the local model to GENERALIZE a lesson from a cluster of episodes
// ("mined" provenance). Path B does the opposite: it preserves the exact
// escalation triplet — the task Archimedes failed, what Archimedes produced,
// and the accepted large-model output — as an instruction-tuning row.
//
//   instruction = the task
//   input       = the relevant context (Archimedes's own output — what the
//                 small model produced before it was rejected)
//   output      = largeModelOutput (the accepted answer)
//
// Both paths are wanted and neither auto-runs. The manual gate stays: nothing
// in this module is invoked except by an explicit `:mine` command.
//
// Every row carries metadata.provenance ("mined" | "correction") so the two
// sources can be ablated separately later. The tag survives into the .jsonl
// because it lives on the TrainingExample itself, and TrainingExample IS the
// serialized row.
// ─────────────────────────────────────────────────────────────────────────────

const TRAINING_DATA_DIRNAME = 'training-data';

/** How much of Archimedes's raw output to keep in `input`. */
const MAX_ARCHIMEDES_CONTEXT_CHARS = 1200;

/** How much of the large-model output to keep. */
const MAX_OUTPUT_CHARS = 2000;

export interface CorrectionResult {
  /** Correction pairs written as training examples. */
  written: TrainingExample[];
  /** Escalation episodes that exist but are not usable (e.g. no large-model output). */
  skipped: number;
  /** Path to the .jsonl new examples were appended to, if any were written. */
  outputPath?: string;
}

/** Build one correction pair from an escalation episode, or null if unusable. */
export function correctionFromEpisode(episode: Episode): TrainingExample | null {
  // A correction pair only exists where Archimedes tried, failed, and the
  // large model produced an accepted answer. Episodes where Archimedes was
  // skipped entirely (gated) have no small-model attempt to correct, and
  // episodes without a large-model output have nothing to learn from.
  if (!episode.archimedesAttempted) return null;
  if (episode.archimedesSucceeded) return null;
  if (!episode.largeModelOutput || episode.largeModelOutput.trim().length === 0) return null;
  if (!episode.task || episode.task.trim().length === 0) return null;

  const archContext = (episode.archimedesOutput ?? '')
    .trim()
    .slice(0, MAX_ARCHIMEDES_CONTEXT_CHARS);

  const inputParts: string[] = [];
  if (archContext.length > 0) {
    inputParts.push(`What Archimedes (small model) produced:\n${archContext}`);
  }
  if (inputParts.length === 0) {
    inputParts.push('The small model\'s attempt was rejected; the corrected answer follows.');
  }

  return {
    instruction: episode.task.trim(),
    input: inputParts.join('\n\n'),
    output: episode.largeModelOutput.trim().slice(0, MAX_OUTPUT_CHARS),
    metadata: {
      projectRoot: episode.projectRoot,
      taskCategory: episode.taskCategory,
      timestamp: episode.timestamp,
      provenance: 'correction',
    },
  };
}

/**
 * Emit correction pairs for every escalation episode loaded for a project
 * (newest first, so duplicates in .jsonl stay ordered oldest→newest).
 *
 * Appends to `training-data/<date>.jsonl` — same file Path A writes — so
 * both provenances land in ONE corpus, distinguishable by `provenance`.
 * Never overwrites; appends only, mirroring the append-only event-log style.
 */
export async function collectCorrections(
  projectRoot: string,
  opts: { limit?: number } = {},
): Promise<CorrectionResult> {
  const episodes = await loadEpisodes(projectRoot, opts.limit);

  // Load newest-first; write oldest-first so the corpus reads chronologically
  // within a run and re-runs don't interleave awkwardly.
  const ordered = [...episodes].reverse();
  const written: TrainingExample[] = [];
  let skipped = 0;

  for (const ep of ordered) {
    const ex = correctionFromEpisode(ep);
    if (ex) written.push(ex);
    else skipped++;
  }

  let outputPath: string | undefined;
  if (written.length > 0) {
    const dir = path.join(projectRoot, TRAINING_DATA_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    outputPath = path.join(dir, `${date}.jsonl`);
    const lines = written.map((ex) => JSON.stringify(ex)).join('\n') + '\n';
    fs.appendFileSync(outputPath, lines);
  }

  return { written, skipped, outputPath };
}

/** One-line human-readable summary for CLI use. */
export function formatCorrectionStats(result: CorrectionResult): string {
  return `correction pairs: ${result.written.length} written, ${result.skipped} skipped (not escalations)`;
}
