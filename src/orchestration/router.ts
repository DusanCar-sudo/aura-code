import type { LLMProvider, HistoryMessage } from '../providers/types.js';
import type { ProjectContext } from '../agent/context.js';
import type { ProjectPerception } from '../perception/types.js';
import type { RouterDecision } from './types.js';
import { ROUTER_SYSTEM_PROMPT } from './router-prompts.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Inputs required to route a task through the orchestrator. */
export interface RouterOptions {
  /** Provider used to call the routing model. */
  provider: LLMProvider;
  /** Loaded project context (name, language, framework, tree, …). */
  context: ProjectContext;
  /** The raw user task string to be routed. */
  task: string;
  /** Optional perception snapshot; risk areas are surfaced to the router when present. */
  perception?: ProjectPerception;
}

/**
 * Asks the model to decide whether `task` should be decomposed into a
 * multi-agent plan or handled by a single agent.
 *
 * Never throws — any parse or provider error returns a safe default that keeps
 * execution on the single-agent path.
 */
export async function routeTask(opts: RouterOptions): Promise<RouterDecision> {
  const { provider, context, task, perception } = opts;

  const userMessage = buildUserMessage(context, task, perception);
  const history: HistoryMessage[] = [{ role: 'user', content: userMessage }];

  let rawText = '';
  try {
    const response = await provider.complete(ROUTER_SYSTEM_PROMPT, history, []);
    rawText = response.text.trim();
  } catch {
    return safeDefault('Provider error — defaulting to single agent');
  }

  return parseDecision(rawText);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildUserMessage(
  context: ProjectContext,
  task: string,
  perception: ProjectPerception | undefined,
): string {
  const lines: string[] = [
    `Project: ${context.name}`,
    `Language: ${context.language}`,
    `Framework: ${context.framework}`,
  ];

  if (perception && perception.constraints.riskAreas.length > 0) {
    lines.push(`Risk areas: ${perception.constraints.riskAreas.join(', ')}`);
  }

  lines.push('', `Task: ${task}`);

  return lines.join('\n');
}

/** Shape the model is expected to return. */
interface RawDecision {
  shouldDecompose: unknown;
  reason: unknown;
  confidence: unknown;
  estimatedSteps?: unknown;
}

function parseDecision(raw: string): RouterDecision {
  let parsed: unknown;
  try {
    // Strip accidental markdown fences the model might emit despite instructions
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return safeDefault('Parse failed — defaulting to single agent');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return safeDefault('Unexpected response shape — defaulting to single agent');
  }

  const r = parsed as RawDecision;

  const shouldDecompose = typeof r.shouldDecompose === 'boolean' ? r.shouldDecompose : false;
  const reason = typeof r.reason === 'string' && r.reason.length > 0
    ? r.reason
    : 'No reason provided';
  const rawConf = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : 0;
  const confidence = Math.min(1, Math.max(0, rawConf));

  const decision: RouterDecision = { shouldDecompose, reason, confidence };

  if (shouldDecompose && typeof r.estimatedSteps === 'number' && r.estimatedSteps > 0) {
    decision.estimatedSteps = Math.round(r.estimatedSteps);
  }

  return decision;
}

function safeDefault(reason: string): RouterDecision {
  return { shouldDecompose: false, reason, confidence: 0 };
}
