import { randomUUID } from 'crypto';
import type { LLMProvider, HistoryMessage } from '../providers/types.js';
import type { ProjectContext } from '../agent/context.js';
import type { ProjectPerception } from '../perception/types.js';
import type { ExecutionPlan, OrchestrationMemory, PlanStep } from './types.js';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './orchestrator-prompts.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Inputs required to produce an execution plan. */
export interface OrchestratorOptions {
  /** Provider used to call the planning model. */
  provider: LLMProvider;
  /** Loaded project context (name, language, framework, tree, …). */
  context: ProjectContext;
  /** The raw user task to be decomposed. */
  task: string;
  /** Optional perception snapshot; surfaced to the planner for risk-aware step design. */
  perception?: ProjectPerception;
  /** Previously persisted memory entries to inject as additional context. */
  memory?: OrchestrationMemory[];
}

/**
 * Calls the planning model and returns a fully initialised `ExecutionPlan`.
 *
 * Steps are assigned fresh UUIDs, statuses are set to `'waiting'`, and the
 * plan status is set to `'pending'`.  If the model response cannot be parsed
 * or fails validation, a safe single-step fallback plan is returned instead.
 *
 * Never throws — always returns an `ExecutionPlan`.
 */
export async function createPlan(opts: OrchestratorOptions): Promise<ExecutionPlan> {
  const { provider, context, task, perception, memory } = opts;

  const system = ORCHESTRATOR_SYSTEM_PROMPT(context, perception);
  const userMessage = buildUserMessage(task, memory);
  const history: HistoryMessage[] = [{ role: 'user', content: userMessage }];

  let rawText = '';
  try {
    const response = await provider.complete(system, history, []);
    rawText = response.text.trim();
  } catch {
    return fallbackPlan(task);
  }

  return parsePlan(rawText, task);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildUserMessage(task: string, memory: OrchestrationMemory[] | undefined): string {
  const lines: string[] = [`Task: ${task}`];

  if (memory && memory.length > 0) {
    lines.push('', 'Relevant memory from previous steps:');
    for (const entry of memory) {
      lines.push(`  [${entry.key}] ${entry.value}`);
    }
  }

  return lines.join('\n');
}

/** Raw shape the model is expected to return before it is validated. */
interface RawPlan {
  goal: unknown;
  steps: unknown;
}

/** Raw shape of a single step before it is validated. */
interface RawStep {
  id: unknown;
  specialist: unknown;
  task: unknown;
  context: unknown;
  dependsOn: unknown;
}

const VALID_SPECIALISTS = new Set<string>(['researcher', 'coder', 'reviewer', 'planner']);

function parsePlan(raw: string, originalTask: string): ExecutionPlan {
  let parsed: unknown;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return fallbackPlan(originalTask);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return fallbackPlan(originalTask);
  }

  const r = parsed as RawPlan;

  const goal = typeof r.goal === 'string' && r.goal.length > 0 ? r.goal : originalTask;

  if (!Array.isArray(r.steps) || r.steps.length === 0) {
    return fallbackPlan(originalTask);
  }

  // BUG 5: reject absurdly large plans that are almost certainly model hallucinations
  if (r.steps.length > 20) return fallbackPlan(originalTask);

  // BUG 3: reject plans where the model reused a step id
  const rawIds = (r.steps as unknown[])
    .map(s => (typeof s === 'object' && s !== null ? (s as Record<string, unknown>).id : undefined));
  if (rawIds.some(id => typeof id !== 'string')) return fallbackPlan(originalTask);
  if (new Set(rawIds).size !== rawIds.length) return fallbackPlan(originalTask);

  // Validate each step shape and collect id → uuid mapping
  const idMap = new Map<string, string>();
  const validatedRaw: RawStep[] = [];

  for (const s of r.steps as unknown[]) {
    if (typeof s !== 'object' || s === null) return fallbackPlan(originalTask);
    const step = s as RawStep;

    if (typeof step.id !== 'string' || step.id.length === 0) return fallbackPlan(originalTask);
    if (typeof step.specialist !== 'string' || !VALID_SPECIALISTS.has(step.specialist)) return fallbackPlan(originalTask);
    if (typeof step.task !== 'string' || step.task.length === 0) return fallbackPlan(originalTask);
    if (typeof step.context !== 'string') return fallbackPlan(originalTask);
    if (!Array.isArray(step.dependsOn)) return fallbackPlan(originalTask);

    idMap.set(step.id, randomUUID());
    validatedRaw.push(step);
  }

  // Validate dependsOn references and check for cycles
  const knownIds = new Set(idMap.keys());
  for (const step of validatedRaw) {
    for (const dep of step.dependsOn as unknown[]) {
      if (typeof dep !== 'string' || !knownIds.has(dep)) return fallbackPlan(originalTask);
    }
  }

  if (hasCycle(validatedRaw)) return fallbackPlan(originalTask);

  // Build final steps with UUIDs and runtime-only fields
  const steps: PlanStep[] = validatedRaw.map(s => ({
    id: idMap.get(s.id as string) ?? randomUUID(),
    specialist: s.specialist as PlanStep['specialist'],
    task: s.task as string,
    context: s.context as string,
    dependsOn: (s.dependsOn as string[]).map(dep => idMap.get(dep) ?? dep),
    status: 'waiting' as const,
  }));

  return {
    id: randomUUID(),
    goal,
    steps,
    status: 'pending',
    created: Date.now(),
  };
}

/**
 * Topological cycle check using DFS with three-colour marking.
 * Returns true if any cycle is detected among step dependencies.
 */
function hasCycle(steps: RawStep[]): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const colour = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const s of steps) {
    colour.set(s.id as string, WHITE);
    adj.set(s.id as string, s.dependsOn as string[]);
  }

  function dfs(id: string): boolean {
    colour.set(id, GRAY);
    for (const dep of adj.get(id) ?? []) {
      const c = colour.get(dep) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(dep)) return true;
    }
    colour.set(id, BLACK);
    return false;
  }

  for (const s of steps) {
    if ((colour.get(s.id as string) ?? WHITE) === WHITE) {
      if (dfs(s.id as string)) return true;
    }
  }
  return false;
}

/** Single-step fallback used whenever parsing or validation fails. */
function fallbackPlan(task: string): ExecutionPlan {
  return {
    id: randomUUID(),
    goal: task,
    steps: [
      {
        id: randomUUID(),
        specialist: 'coder',
        task,
        context: 'Fallback single-step plan — orchestrator could not parse a structured plan.',
        dependsOn: [],
        status: 'waiting',
      },
    ],
    status: 'pending',
    created: Date.now(),
  };
}
