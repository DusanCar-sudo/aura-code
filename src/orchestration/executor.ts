import type { LLMProvider, HistoryMessage } from '../providers/types.js';
import type { ProjectContext } from '../agent/context.js';
import type { ProjectPerception } from '../perception/types.js';
import type { ExecutionPlan, PlanStep, OrchestrationMemory, ReviewVerdict } from './types.js';
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
        // A re-run step replaces its earlier entry rather than appending a
        // second one under the same key — otherwise the retried coder sees
        // both attempts in its context.
        const prior = memory.findIndex(m => m.stepId === step.id);
        if (prior !== -1) memory.splice(prior, 1);
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

    applyReviewFeedback(plan.steps, batch, memory);

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

/**
 * Maximum times a coder step may be re-run after a blocking review.
 * 1 = at most two implementation attempts. A retry loop multiplies cost and
 * there is no per-session token ceiling yet, so this stays at 1 until one
 * exists.
 */
const MAX_REVIEW_RETRIES = 1;

/**
 * How often the `blocking` field was absent and the severity net caught it.
 * A non-zero count means the reviewer prompt is not reliably producing the
 * required field — the fallback is a safety net, not the intended path.
 */
let severityFallbackCount = 0;

/** Number of times the severity fallback has fired this process. */
export function reviewFallbackCount(): number { return severityFallbackCount; }

/** Test seam. */
export function resetReviewFallbackCount(): void { severityFallbackCount = 0; }

/**
 * Parse the reviewer's structured verdict.
 *
 * Returns `null` when the output is not parseable as a verdict. A null result
 * is treated as non-blocking by the caller: a reviewer that cannot emit JSON
 * has failed to give us a decision, and guessing "probably blocking" from
 * unparseable text is exactly the prose-inference that makes retry loops
 * unbounded.
 *
 * When the object parses but omits `blocking`, we fall back to severity and
 * fail CLOSED (critical/major ⇒ blocking). With the retry cap at 1 the cost
 * of a wrong block is one extra coder run; the cost of wrongly passing is a
 * broken step silently marked done.
 */
export function parseReviewVerdict(raw: string | undefined): ReviewVerdict | null {
  if (!raw) return null;

  // The reviewer is told to emit only JSON, but models routinely wrap it in
  // a fence or add a trailing sentence. Take the outermost brace pair.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.issues)) return null;

  const issues = obj.issues.filter(
    (i): i is ReviewVerdict['issues'][number] =>
      typeof i === 'object' && i !== null && typeof (i as Record<string, unknown>).description === 'string',
  );

  // Prefer the reviewer's explicit call. Fall back to severity only when the
  // field is absent entirely — that is still structured data, not prose.
  if (typeof obj.blocking === 'boolean') {
    return { issues, blocking: obj.blocking };
  }

  severityFallbackCount++;
  const blocking = issues.some(i => i.severity === 'critical' || i.severity === 'major');
  process.stderr.write(
    `[orchestration] reviewer omitted the required "blocking" field ` +
    `(occurrence ${severityFallbackCount}); falling back to severity → ` +
    `blocking=${blocking}. The reviewer prompt should be producing this.\n`,
  );
  return { issues, blocking };
}

/**
 * The revise edge: when a reviewer step finishes with a blocking verdict,
 * send the coder steps it reviewed back to `'waiting'` for one more attempt,
 * and re-arm the reviewer so it re-checks the result.
 *
 * When the retry budget is already spent and the verdict is still blocking,
 * the review is marked `'failed'` and its dependents skipped — a blocking
 * verdict is never silently accepted.
 */
function applyReviewFeedback(
  steps: PlanStep[],
  batch: PlanStep[],
  memory: OrchestrationMemory[],
): void {
  for (const review of batch) {
    if (review.specialist !== 'reviewer' || review.status !== 'done') continue;

    const verdict = parseReviewVerdict(review.result);
    if (!verdict?.blocking) continue;

    const targets = review.dependsOn
      .map(id => steps.find(s => s.id === id))
      .filter((s): s is PlanStep => s !== undefined && s.specialist === 'coder');

    const retryable = targets.filter(t => (t.retries ?? 0) < MAX_REVIEW_RETRIES);

    if (retryable.length === 0) {
      const summary = verdict.issues.length > 0
        ? verdict.issues.map(i => `[${i.severity}] ${i.description} (${i.location})`).join('; ')
        : 'no issue detail supplied';
      review.status = 'failed';
      review.result =
        `Review still blocking after ${MAX_REVIEW_RETRIES} ` +
        `retr${MAX_REVIEW_RETRIES === 1 ? 'y' : 'ies'}: ${summary}`;
      propagateSkips(steps, review.id);
      continue;
    }

    for (const target of retryable) {
      target.retries = (target.retries ?? 0) + 1;
      target.status = 'waiting';
      // Drop the superseded implementation from memory so the retry is not
      // handed its own previous attempt as "a finding from a previous step".
      const prior = memory.findIndex(m => m.stepId === target.id);
      if (prior !== -1) memory.splice(prior, 1);
    }
    // Re-arm the review itself; it re-runs once its targets are done again.
    review.status = 'waiting';
  }
}

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
