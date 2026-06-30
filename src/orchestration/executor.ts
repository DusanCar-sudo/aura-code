import type { LLMProvider, HistoryMessage } from '../providers/types.js';
import type { ProjectContext } from '../agent/context.js';
import type { ProjectPerception } from '../perception/types.js';
import type { ExecutionPlan, PlanStep, OrchestrationMemory } from './types.js';
import type { Display } from '../cli/display.js';
import { runSpecialist } from './specialists.js';
import { planStore } from './plan-store.js';
import { competenceStore, PRIMARY_DOMAIN } from './competence.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Options passed to the plan executor. */
export interface ExecutorOptions {
  /** The plan to execute (mutated in place as steps progress). */
  plan: ExecutionPlan;
  /** Provider used by every specialist step. */
  provider: LLMProvider;
  /** Loaded project context passed to specialists. */
  context: ProjectContext;
  /** Display sink for progress events. */
  display: Display;
  /** Optional perception snapshot forwarded to each specialist. */
  perception?: ProjectPerception;
  /** Optional abort signal; sets plan status to `'aborted'` when fired. */
  signal?: AbortSignal;
  /** Maximum steps running concurrently. Defaults to 3. */
  maxParallel?: number;
}

/**
 * Runs all steps in `opts.plan` respecting their dependency graph.
 *
 * Steps whose `dependsOn` arrays are all resolved run immediately, up to
 * `maxParallel` at once using `Promise.allSettled`.  When a step fails,
 * every step that transitively depends on it is marked `'skipped'` so
 * independent branches continue unaffected.  The final plan is persisted to
 * disk and returned.
 *
 * Never throws — if every step fails, the plan is returned with
 * status `'failed'`.
 */
export async function executePlan(opts: ExecutorOptions): Promise<ExecutionPlan> {
  const { plan, provider, context, display, perception, signal } = opts;
  const maxParallel = opts.maxParallel ?? 3;

  plan.status = 'running';
  display.header(`Plan: ${plan.goal}`, `${plan.steps.length} step${plan.steps.length !== 1 ? 's' : ''}`);
  display.showPlan(plan);

  const memory: OrchestrationMemory[] = [];

  while (true) {
    if (signal?.aborted) {
      plan.status = 'aborted';
      plan.completed = Date.now();
      await persist(plan);
      return plan;
    }

    const ready = findReadySteps(plan.steps);

    if (ready.length === 0) {
      // Catch any waiting steps blocked by a failed/skipped dep that hasn't
      // been propagated yet, then decide whether to stop.
      propagateAllSkips(plan.steps);
      if (plan.steps.every(s => isTerminal(s.status))) break;
      // Nothing runnable and plan is not fully terminal — shouldn't happen
      // with a valid acyclic plan, but guard to avoid an infinite loop.
      break;
    }

    const batch = ready.slice(0, maxParallel);

    for (const step of batch) {
      step.status = 'running';
      display.stepStarted(step);
    }

    const settled = await Promise.allSettled(
      batch.map(step =>
        runSpecialist({ provider, context, perception, step, memory: [...memory], display, signal }),
      ),
    );

    for (let i = 0; i < settled.length; i++) {
      const step   = batch[i]!;
      const result = settled[i]!;

      if (result.status === 'fulfilled' && result.value.success) {
        step.status     = 'done';
        step.result     = result.value.result;
        step.tokensUsed = result.value.tokensUsed;
        step.durationMs = result.value.durationMs;

        const entry: OrchestrationMemory = {
          key: step.id,
          value: result.value.result,
          stepId: step.id,
          timestamp: Date.now(),
        };
        memory.push(entry);
        try { await planStore.saveMemory(context.root, entry); } catch { /* best-effort */ }

        competenceStore.recordOutcome(context.root, {
          specialist: step.specialist,
          domain: PRIMARY_DOMAIN[step.specialist],
          success: true,
          quality: 1,
        }).catch(() => { /* best-effort */ });

        display.stepCompleted(step, step.result);
      } else {
        const errMsg =
          result.status === 'rejected'
            ? String(result.reason)
            : result.value.result;

        step.status     = 'failed';
        step.result     = errMsg;
        step.durationMs = result.status === 'fulfilled' ? result.value.durationMs : 0;

        competenceStore.recordOutcome(context.root, {
          specialist: step.specialist,
          domain: PRIMARY_DOMAIN[step.specialist],
          success: false,
        }).catch(() => { /* best-effort */ });

        propagateSkips(plan.steps, step.id);
      }
    }

    if (plan.steps.every(s => isTerminal(s.status))) break;
  }

  // ── Finalise plan ────────────────────────────────────────────────────────────

  plan.outcome     = await synthesise(plan, provider, context);
  plan.status      = plan.steps.some(s => s.status === 'failed') ? 'failed' : 'done';
  plan.completed   = Date.now();
  plan.totalTokens = plan.steps.reduce((n, s) => n + (s.tokensUsed ?? 0), 0);

  const doneCount = plan.steps.filter(s => s.status === 'done').length;
  display.summary(plan.outcome, plan.steps.length, doneCount);

  await persist(plan);
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────
// synthesise
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Asks the provider to write a coherent summary of all completed step results.
 *
 * Falls back to a plain concatenation of step results if the provider call
 * fails or returns empty text.  Never throws.
 */
export async function synthesise(
  plan: ExecutionPlan,
  provider: LLMProvider,
  context: ProjectContext,
): Promise<string> {
  const done = plan.steps.filter(s => s.status === 'done' && s.result);

  if (done.length === 0) {
    return plan.steps.some(s => s.status === 'failed')
      ? 'All steps failed — no changes were made.'
      : 'No steps completed.';
  }

  const stepBlocks = done
    .map((s, i) => `Step ${i + 1} [${s.specialist}] — ${s.task}\n${s.result}`)
    .join('\n\n');

  const system =
    `You are summarising the results of a multi-agent coding task ` +
    `for project "${context.name}". ` +
    `Be concise — 3 to 5 sentences. State what was accomplished and what changed.`;

  const history: HistoryMessage[] = [{
    role: 'user',
    content:
      `Goal: ${plan.goal}\n\n` +
      `Here are the results of each specialist step. ` +
      `Synthesise them into a coherent summary of what was accomplished and what changed.\n\n` +
      stepBlocks,
  }];

  try {
    const response = await provider.complete(system, history, []);
    const text = response.text.trim();
    return text.length > 0 ? text : fallbackSynthesis(done);
  } catch {
    return fallbackSynthesis(done);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns steps that are `'waiting'` and have all dependencies in `'done'` state. */
function findReadySteps(steps: PlanStep[]): PlanStep[] {
  const doneIds = new Set(steps.filter(s => s.status === 'done').map(s => s.id));
  return steps.filter(
    s => s.status === 'waiting' && s.dependsOn.every(dep => doneIds.has(dep)),
  );
}

/**
 * Marks all `'waiting'` steps that directly depend on `failedId` as
 * `'skipped'`, then recursively propagates through their dependents (BFS).
 */
function propagateSkips(steps: PlanStep[], failedId: string): void {
  let frontier = [failedId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const step of steps) {
        if (step.status === 'waiting' && step.dependsOn.includes(id)) {
          step.status = 'skipped';
          next.push(step.id);
        }
      }
    }
    frontier = next;
  }
}

/**
 * Sweeps all steps and ensures any `'waiting'` step whose dependency set
 * includes a failed or skipped step is itself marked `'skipped'`.
 * Runs to fixpoint to handle multi-level chains.
 */
function propagateAllSkips(steps: PlanStep[]): void {
  const blocked = new Set(
    steps
      .filter(s => s.status === 'failed' || s.status === 'skipped')
      .map(s => s.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (step.status === 'waiting' && step.dependsOn.some(d => blocked.has(d))) {
        step.status = 'skipped';
        blocked.add(step.id);
        changed = true;
      }
    }
  }
}

function isTerminal(status: PlanStep['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'skipped';
}

function fallbackSynthesis(steps: PlanStep[]): string {
  return steps
    .map(s => `[${s.specialist}] ${(s.result ?? '').slice(0, 300)}`)
    .join('\n\n');
}

async function persist(plan: ExecutionPlan): Promise<void> {
  try { await planStore.save(plan); } catch { /* best-effort */ }
}
