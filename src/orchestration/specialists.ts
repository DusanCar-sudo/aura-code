import type { LLMProvider } from '../providers/types.js';
import type { ProjectContext } from '../agent/context.js';
import type { PlanStep, OrchestrationMemory } from './types.js';
import type { ProjectPerception } from '../perception/types.js';
import type { Display } from '../cli/display.js';
import { runAgentLoop } from '../agent/loop.js';
import { PermissionSystem } from '../safety/permissions.js';
import { RESEARCHER_SYSTEM_PROMPT, REVIEWER_SYSTEM_PROMPT, CODER_CONTEXT_TEMPLATE } from './specialist-prompts.js';
import { DEFAULTS } from '../config/defaults.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public interfaces
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration passed to every specialist invocation. */
export interface SpecialistOptions {
  /** LLM provider used for this step. */
  provider: LLMProvider;
  /** Loaded project context. */
  context: ProjectContext;
  /** Optional perception snapshot for context-aware execution. */
  perception?: ProjectPerception;
  /** The plan step to execute. */
  step: PlanStep;
  /** Memory entries from previously completed steps. */
  memory: OrchestrationMemory[];
  /** Display interface for progress output. */
  display: Display;
  /** Optional abort signal for cancellation. */
  signal?: AbortSignal;
}

/** Structured result returned by every specialist. */
export interface SpecialistResult {
  /** The specialist's output — research summary, review result, or implementation log. */
  result: string;
  /** Whether the step completed successfully. */
  success: boolean;
  /** Total tokens consumed (input + output). */
  tokensUsed: number;
  /** Wall-clock duration of the step in milliseconds. */
  durationMs: number;
  /** id of the PlanStep this result corresponds to. */
  stepId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// runResearcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a research step.
 * Runs within read-only permissions so the agent cannot create, edit, or
 * delete files. The researcher system prompt is prepended to the task so
 * the agent follows the structured output format.
 */
export async function runResearcher(opts: SpecialistOptions): Promise<SpecialistResult> {
  const start = Date.now();
  const task = `${RESEARCHER_SYSTEM_PROMPT}\n\n---\n\n${buildTask(opts)}`;

  try {
    const result = await runAgentLoop({
      provider: opts.provider,
      task,
      context: opts.context,
      permissions: new PermissionSystem('read-only'),
      display: opts.display,
      maxTurns: 10,
      pricingModel: opts.provider.model,
    });

    return {
      result: result.summary,
      success: result.success,
      tokensUsed: result.usage.totalTokens,
      durationMs: Date.now() - start,
      stepId: opts.step.id,
    };
  } catch (e) {
    return failResult(opts.step.id, `Research error: ${String(e)}`, Date.now() - start);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runReviewer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a review step.
 * Runs within read-only permissions so the agent cannot create, edit, or
 * delete files. The reviewer system prompt is prepended to the task so
 * the agent follows the structured issues format.
 */
export async function runReviewer(opts: SpecialistOptions): Promise<SpecialistResult> {
  const start = Date.now();
  const task = `${REVIEWER_SYSTEM_PROMPT}\n\n---\n\n${buildTask(opts)}`;

  try {
    const result = await runAgentLoop({
      provider: opts.provider,
      task,
      context: opts.context,
      permissions: new PermissionSystem('read-only'),
      display: opts.display,
      maxTurns: 10,
      pricingModel: opts.provider.model,
    });

    return {
      result: result.summary,
      success: result.success,
      tokensUsed: result.usage.totalTokens,
      durationMs: Date.now() - start,
      stepId: opts.step.id,
    };
  } catch (e) {
    return failResult(opts.step.id, `Review error: ${String(e)}`, Date.now() - start);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runCoder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a coding step.
 * The coder has full tool access (normal permissions). Step context and
 * relevant memory are injected into the task description via
 * `CODER_CONTEXT_TEMPLATE`.
 */
export async function runCoder(opts: SpecialistOptions): Promise<SpecialistResult> {
  const start = Date.now();
  const task = CODER_CONTEXT_TEMPLATE(opts.step, opts.memory);

  try {
    const result = await runAgentLoop({
      provider: opts.provider,
      task,
      context: opts.context,
      permissions: new PermissionSystem('normal'),
      display: opts.display,
      maxTurns: DEFAULTS.maxTurns,
      pricingModel: opts.provider.model,
    });

    return {
      result: result.summary,
      success: result.success,
      tokensUsed: result.usage.totalTokens,
      durationMs: Date.now() - start,
      stepId: opts.step.id,
    };
  } catch (e) {
    return failResult(opts.step.id, `Coder error: ${String(e)}`, Date.now() - start);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runSpecialist — dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatches to the correct specialist based on `step.specialist`.
 * - `researcher` → runResearcher
 * - `reviewer`   → runReviewer
 * - `coder`      → runCoder
 * - `planner`    → runResearcher (read-only planning, same constraints)
 *
 * Catches all errors and returns an error message as the result. Never throws.
 */
export async function runSpecialist(opts: SpecialistOptions): Promise<SpecialistResult> {
  try {
    switch (opts.step.specialist) {
      case 'researcher':
        return await runResearcher(opts);
      case 'reviewer':
        return await runReviewer(opts);
      case 'coder':
        return await runCoder(opts);
      case 'planner':
        return await runResearcher(opts);
      default:
        return failResult(opts.step.id, `Unknown specialist type: ${opts.step.specialist}`, 0);
    }
  } catch (e) {
    return failResult(opts.step.id, `Specialist error (${opts.step.specialist}): ${String(e)}`, 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildTask(opts: SpecialistOptions): string {
  const lines: string[] = [];

  lines.push(`Task: ${opts.step.task}`);

  if (opts.step.context) {
    lines.push('');
    lines.push('Context:');
    lines.push(opts.step.context);
  }

  if (opts.memory.length > 0) {
    lines.push('');
    lines.push('Relevant findings from previous steps:');
    for (const entry of opts.memory) {
      if (entry.stepId === opts.step.id) continue;
      lines.push(`  [${entry.key}] ${entry.value.slice(0, 300)}`);
    }
  }

  return lines.join('\n');
}

function failResult(stepId: string, message: string, durationMs: number): SpecialistResult {
  return {
    result: message,
    success: false,
    tokensUsed: 0,
    durationMs,
    stepId,
  };
}
