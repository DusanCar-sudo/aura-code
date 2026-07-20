import * as fs from 'fs';
import * as path from 'path';
import { createProvider } from '../providers/factory.js';
import { DEFAULT_ARCHIMEDES_CONFIG } from '../archimedes/types.js';
import type { TrainingExample, ArchimedesConfig } from '../archimedes/types.js';
import type { MinedConcept } from './extract.js';

/**
 * Papa Archimedes — reasoning over Baby Archimedes's concepts.
 *
 * Takes the structural concepts Baby Archimedes found (pure statistics, no LLM)
 * and runs ONE local-model call per qualifying concept to decide:
 *   - is this concept a real, generalizable lesson, or coincidental noise?
 *   - if real, write it as a TrainingExample (the type already exists in
 *     archimedes/types.ts — this reuses it rather than inventing a new shape).
 *
 * Mirrors src/dream/reconcile.ts's pattern deliberately:
 *   - one provider.complete() call per unit of work
 *   - defensive JSON parsing (fence-stripping, array-extraction fallback)
 *   - best-effort: any failure returns null for that concept, never throws
 *   - the caller (mineExperience + refineConcepts together) decides whether
 *     to gate on confidence/frequency before spending a model call
 *
 * Model: the ArchimedesAlternator's configured small model (Ollama, e.g.
 * qwen2.5-coder:1.5b) — NOT the dream-consolidation fallback model and NOT
 * the user's large active provider. Papa Archimedes's job (judging whether a
 * cluster is a real pattern) is closer to ArchimedesAlternator's existing
 * "small model attempts first" philosophy than to dream consolidation's
 * "summarize a day of work" job. Reusing DEFAULT_ARCHIMEDES_CONFIG.modelName
 * keeps Aura's "small model" vocabulary consistent across both systems.
 *
 * Deduplication against reconciled memory: if `dreams/.reconciled.md`
 * exists, its content is included in the prompt as "already known" so
 * Papa Archimedes doesn't re-derive lessons the dream system already distilled.
 * This avoids redundant training rows from two independent pipelines
 * converging on the same insight.
 *
 * Output: appended to `training-data/<date>.jsonl`, one TrainingExample
 * per line — the exact shape needed for external fine-tuning workflows
 * (same approach used for the Serbian Legal LLM corpus: structured,
 * file-based, no proprietary format).
 */

const TRAINING_DATA_DIRNAME = 'training-data';
const MIN_CONFIDENCE_TO_REFINE = 0.4;
const MIN_FREQUENCY_TO_REFINE = 5;

export interface RefinementResult {
  /** Concepts that were judged actionable and written as training examples. */
  accepted: TrainingExample[];
  /** Concepts judged noise (or the model failed) — not written. */
  rejected: number;
  /** Concepts skipped before even calling the model (below confidence/frequency gate). */
  skipped: number;
  /** Path to the .jsonl file new examples were appended to, if any were written. */
  outputPath?: string;
}

function trainingDataDir(projectRoot: string): string {
  return path.join(projectRoot, TRAINING_DATA_DIRNAME);
}

/** Load dreams/.reconciled.md content for dedup context, or '' if absent. */
function loadReconciledContext(projectRoot: string): string {
  const reconciledPath = path.join(projectRoot, 'dreams', '.reconciled.md');
  try {
    if (!fs.existsSync(reconciledPath)) return '';
    const raw = fs.readFileSync(reconciledPath, 'utf8');
    // Strip frontmatter — only the belief content matters for dedup.
    let content = raw;
    if (content.startsWith('---')) {
      const endIdx = content.indexOf('---', 3);
      if (endIdx > 0) content = content.slice(endIdx + 3).trim();
    }
    return content.length > 3000 ? content.slice(0, 3000) + '\n[...truncated]' : content;
  } catch {
    return '';
  }
}

function buildRefinementPrompt(
  concept: MinedConcept,
  reconciledContext: string,
): { system: string; user: string } {
  const system = `You are Papa Archimedes, judging whether a statistically-detected pattern in Aura's task history is a REAL, GENERALIZABLE lesson worth turning into training data — or just coincidental keyword overlap with no real pattern.

You are given:
- A concept: a cluster of similar tasks found by pure keyword/frequency analysis (no AI was involved in finding it — it's just statistics).
- Example task strings from that cluster.
- Aura's already-known lessons (from dream reconciliation), so you don't repeat what's already captured.

Decide: ACCEPT or REJECT.

ACCEPT only if:
- The examples show a genuine recurring behavior or failure mode, not just shared vocabulary.
- The lesson would generalize usefully to future tasks (not a one-off).
- It is NOT already covered by the known lessons provided.

REJECT if:
- The cluster is coincidental (e.g. tasks just happen to share a common word like "fix" or "bug" with no deeper pattern).
- The lesson is already captured in the known lessons.
- There isn't enough signal to state a confident, specific lesson.

If you ACCEPT, write the lesson as ONE training example:
{
  "instruction": "a generalized question or directive Aura might face",
  "input": "brief context — what kind of task this is",
  "output": "the lesson, phrased as correct future behavior, one or two sentences"
}

Respond with ONLY a JSON object. No markdown fences, no preamble.

If REJECT, respond with ONLY: {"decision": "reject"}
If ACCEPT, respond with: {"decision": "accept", "instruction": "...", "input": "...", "output": "..."}`;

  const knownSection = reconciledContext
    ? `\n\nAlready-known lessons (do not repeat these):\n${reconciledContext}`
    : '\n\n(No reconciled memory exists yet — nothing is already known.)';

  const user = `Concept: ${concept.concept}
Category: ${concept.category}
Keywords: ${concept.keywords.join(', ')}
Frequency: ${concept.frequency} episodes
Confidence: ${concept.confidence}

Example tasks from this cluster:
${concept.examples.map(e => `- ${e}`).join('\n')}${knownSection}`;

  return { system, user };
}

interface RawDecision {
  decision?: string;
  instruction?: string;
  input?: string;
  output?: string;
}

function parseDecision(raw: string): RawDecision | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/**
 * Build the small local provider Papa Archimedes reasons with. Reuses
 * ArchimedesAlternator's configured model rather than inventing a separate
 * config surface — `archimedesConfig` defaults to DEFAULT_ARCHIMEDES_CONFIG if the
 * caller doesn't have one already loaded (e.g. from .aura.json).
 */
function buildPapaArchimedesProvider(archimedesConfig: ArchimedesConfig) {
  return createProvider({
    model: `ollama/${archimedesConfig.modelName}`,
    baseUrl: archimedesConfig.ollamaBaseUrl,
    maxTokens: 512, // judging one concept is a small, bounded task
  });
}

/**
 * Refine a single concept: ask the local model whether it's a real lesson,
 * and if so, return the TrainingExample. Returns null on REJECT or on any
 * failure (unreachable model, malformed response, etc.) — best-effort,
 * same invariant as dream reconciliation.
 */
async function refineOne(
  concept: MinedConcept,
  reconciledContext: string,
  provider: ReturnType<typeof createProvider>,
  projectRoot: string,
): Promise<TrainingExample | null> {
  const { system, user } = buildRefinementPrompt(concept, reconciledContext);

  let rawResponse: string;
  try {
    const res = await provider.complete(system, [{ role: 'user', content: user }], []);
    rawResponse = (res.text ?? '').trim();
    if (!rawResponse) return null;
  } catch {
    return null;
  }

  const decision = parseDecision(rawResponse);
  if (!decision || decision.decision !== 'accept') return null;
  if (!decision.instruction || !decision.input || !decision.output) return null;

  return {
    instruction: decision.instruction.trim(),
    input: decision.input.trim(),
    output: decision.output.trim(),
    metadata: {
      projectRoot,
      taskCategory: concept.category,
      timestamp: Date.now(),
    },
  };
}

/**
 * Run Papa Archimedes over a set of Baby Archimedes's concepts.
 *
 * Gates BEFORE calling the model: concepts below MIN_CONFIDENCE_TO_REFINE
 * or MIN_FREQUENCY_TO_REFINE are skipped entirely (not worth a model call
 * to judge — Baby Archimedes's own confidence already says this is weak signal).
 *
 * Accepted training examples are appended to training-data/<date>.jsonl.
 * Never overwrites — each run appends, since this mirrors an append-only
 * event log philosophy, same as dreams/.
 */
export async function refineConcepts(opts: {
  projectRoot: string;
  concepts: MinedConcept[];
  archimedesConfig?: ArchimedesConfig;
}): Promise<RefinementResult> {
  const { projectRoot, concepts } = opts;
  const archimedesConfig = opts.archimedesConfig ?? DEFAULT_ARCHIMEDES_CONFIG;

  const reconciledContext = loadReconciledContext(projectRoot);
  const provider = buildPapaArchimedesProvider(archimedesConfig);

  const accepted: TrainingExample[] = [];
  let rejected = 0;
  let skipped = 0;

  for (const concept of concepts) {
    if (concept.confidence < MIN_CONFIDENCE_TO_REFINE || concept.frequency < MIN_FREQUENCY_TO_REFINE) {
      skipped++;
      continue;
    }

    const example = await refineOne(concept, reconciledContext, provider, projectRoot);
    if (example) {
      accepted.push(example);
    } else {
      rejected++;
    }
  }

  let outputPath: string | undefined;
  if (accepted.length > 0) {
    const dir = trainingDataDir(projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    outputPath = path.join(dir, `${date}.jsonl`);
    const lines = accepted.map(ex => JSON.stringify(ex)).join('\n') + '\n';
    fs.appendFileSync(outputPath, lines);
  }

  return { accepted, rejected, skipped, outputPath };
}
