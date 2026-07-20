import type { HistoryMessage, LLMProvider } from '../providers/types.js';
import { runAgentLoop, type LoopResult } from '../agent/loop.js';
import type { ProjectContext } from '../agent/context.js';
import { PermissionSystem } from '../safety/permissions.js';
import type { Display } from '../cli/display.js';
import type { ContextHealthTracker } from '../cli/context-health.js';
import type { ArchimedesConfig } from '../archimedes/types.js';
import { ArchimedesAlternator, type AlternatorRunResult } from '../archimedes/alternator.js';
import { episodeStore } from '../archimedes/episode-capture.js';

// ─────────────────────────────────────────────────────────────────────────────
// Strategy contract
//
// Generalization of AlternatorOptions/AlternatorRunResult (src/archimedes/alternator.ts)
// so ArchimedesAlternator becomes one orchestration strategy among several, not the
// only path. Hardware assumptions (weak local model + paid cloud escalation)
// live inside individual strategies, never in this contract.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-run options shared by every orchestration strategy.
 * Field-for-field generalization of AlternatorOptions minus the
 * alternator-specific pair (archimedesConfig, largeModelProvider), which becomes
 * per-strategy constructor state.
 */
export interface StrategyRunOptions {
  projectRoot: string;
  context: ProjectContext;
  /** When set, routing and loop events are surfaced to the user. */
  display?: Display;
  /**
   * The session's permission system. Sanitized by the base class before any
   * strategy sees it — see {@link BaseOrchestrationStrategy}.
   */
  permissions?: PermissionSystem;
  /** Confirmation prompt for needs-confirm tool calls, threaded into the loop. */
  confirmFn?: (message: string) => Promise<boolean>;
  /** Prior conversation history (multi-turn REPL), threaded into the loop. */
  initialHistory?: HistoryMessage[];
  /** Abort signal (REPL Ctrl+C / :stop) — forwarded to inner agent loops. */
  abortSignal?: AbortSignal;
  /** Shared context-health tracker (the REPL's) — forwarded to inner agent loops. */
  healthTracker?: ContextHealthTracker;
}

/** Generalization of AlternatorRunResult. */
export interface StrategyRunResult {
  /** Final user-facing output text. */
  result: string;
  /** Full LoopResult from whichever model produced the final output. */
  loopResult: LoopResult;
  /** Which model id actually produced the final output. */
  modelUsed: string;
  /** Strategy-specific extras (e.g. the alternator's Episode + decision). */
  details?: unknown;
}

export interface OrchestrationStrategy {
  /** Stable identifier for logs, config, and episode records. */
  name: string;
  /** Runs one task. Must never throw — report failures via `result`/`loopResult`. */
  run(task: string, opts: StrategyRunOptions): Promise<StrategyRunResult>;
  /** Optional strategy-specific statistics (episodes, token split, …). */
  getStats?(): Promise<unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base class — safety contract enforced once, not per strategy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enforces the safety invariants that were previously buried inside
 * ArchimedesAlternator, so no new strategy can accidentally drop them:
 *
 * 1. A run with no permission system defaults to 'normal' — NEVER 'auto'.
 *    An orchestration layer must not auto-approve destructive operations the
 *    user's chosen mode would have prompted for.
 * 2. Any model a strategy considers unproven/untrusted must run through
 *    {@link BaseOrchestrationStrategy.untrustedPermissions} (always
 *    read-only, independent of session permissions).
 */
export abstract class BaseOrchestrationStrategy implements OrchestrationStrategy {
  abstract name: string;

  async run(task: string, opts: StrategyRunOptions): Promise<StrategyRunResult> {
    return this.execute(task, {
      ...opts,
      permissions: opts.permissions ?? new PermissionSystem('normal'),
    });
  }

  /** Permissions for an unproven local model: always read-only. */
  protected untrustedPermissions(): PermissionSystem {
    return new PermissionSystem('read-only');
  }

  /** Strategy body. `opts.permissions` is guaranteed set and sanitized. */
  protected abstract execute(
    task: string,
    opts: StrategyRunOptions & { permissions: PermissionSystem },
  ): Promise<StrategyRunResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ArchimedesAlternatorStrategy — wraps the existing ArchimedesAlternator unchanged
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Weak-local-model + cloud-escalation strategy: the existing ArchimedesAlternator
 * behind the strategy interface. The alternator itself is not modified; a new
 * instance is built per run because AlternatorOptions carries per-run state
 * (history, abort signal, health tracker).
 */
export class ArchimedesAlternatorStrategy extends BaseOrchestrationStrategy {
  name = 'archimedes-alternator';

  constructor(
    private readonly archimedesConfig: ArchimedesConfig,
    private readonly largeModelProvider: LLMProvider,
    /** Kept so getStats() can answer without a prior run. */
    private readonly projectRoot: string,
  ) {
    super();
  }

  protected async execute(
    task: string,
    opts: StrategyRunOptions & { permissions: PermissionSystem },
  ): Promise<StrategyRunResult> {
    const alternator = new ArchimedesAlternator({
      archimedesConfig: this.archimedesConfig,
      largeModelProvider: this.largeModelProvider,
      projectRoot: opts.projectRoot,
      context: opts.context,
      display: opts.display,
      permissions: opts.permissions,
      confirmFn: opts.confirmFn,
      initialHistory: opts.initialHistory,
      abortSignal: opts.abortSignal,
      healthTracker: opts.healthTracker,
    });
    const res: AlternatorRunResult = await alternator.run(task);
    return {
      result: res.result,
      loopResult: res.loopResult,
      modelUsed: res.usedArchimedes ? this.archimedesConfig.modelName : this.largeModelProvider.model,
      details: { episode: res.episode, decision: res.decision, usedArchimedes: res.usedArchimedes },
    };
  }

  async getStats(): Promise<unknown> {
    // Same source ArchimedesAlternator.getStats() reads — avoids constructing an
    // alternator (which needs a full ProjectContext) just for stats.
    return episodeStore.getEpisodeStats(this.projectRoot);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SingleModelStrategy — powerful-local-machine case: one model, no alternation
// ─────────────────────────────────────────────────────────────────────────────

function createNoopDisplay(): Display {
  return {
    agentThinking: () => {},
    streamText: () => {},
    streamEnd: () => {},
    toolStart: () => {},
    toolCall: () => {},
    toolResult: () => {},
    toolBlocked: () => {},
    warning: () => {},
    success: () => {},
    error: () => {},
    header: () => {},
    summary: () => {},
    showPlan: () => {},
    stepStarted: () => {},
    stepCompleted: () => {},
    contextBar: () => {},
    contextDashboard: () => {},
    compactionEvent: () => {},
  };
}

/** One model handles everything. No alternation, no escalation, no episodes. */
export class SingleModelStrategy extends BaseOrchestrationStrategy {
  name = 'single-model';

  constructor(private readonly provider: LLMProvider) {
    super();
  }

  protected async execute(
    task: string,
    opts: StrategyRunOptions & { permissions: PermissionSystem },
  ): Promise<StrategyRunResult> {
    try {
      const loopResult = await runAgentLoop({
        provider: this.provider,
        task,
        context: opts.context,
        permissions: opts.permissions,
        display: opts.display ?? createNoopDisplay(),
        confirmFn: opts.confirmFn,
        initialHistory: opts.initialHistory,
        abortSignal: opts.abortSignal,
        healthTracker: opts.healthTracker,
      });
      const summary = loopResult.summary?.trim();
      return {
        result: summary && summary.length > 0
          ? summary
          : loopResult.success
            ? '(Task completed with no output)'
            : `Model did not complete: ${loopResult.summary}`,
        loopResult,
        modelUsed: this.provider.model,
      };
    } catch (e) {
      const msg = `Model error: ${String(e)}`;
      return {
        result: msg,
        loopResult: {
          success: false,
          summary: msg,
          turns: 0,
          toolCallCount: 0,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 },
          costUsd: 0,
          history: [],
          toolCallLog: [],
        },
        modelUsed: this.provider.model,
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default strategy selection from local capability
// ─────────────────────────────────────────────────────────────────────────────

const OLLAMA_PING_MS = 3_000;

/** Checks whether an Ollama OpenAI-compatible endpoint responds. Never throws. */
async function isOllamaAvailable(baseUrl: string): Promise<boolean> {
  try {
    const root = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_PING_MS);
    const res = await fetch(`${root}/v1/models`, {
      method: 'GET',
      headers: { Authorization: 'Bearer ollama' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export interface StrategySelectionInput {
  archimedesConfig: ArchimedesConfig;
  largeModelProvider: LLMProvider;
  projectRoot: string;
}

/**
 * Picks a default strategy from what the local machine can actually run:
 * Ollama reachable and Archimedes enabled → alternation; otherwise the single
 * (large) model handles everything. Config can always override this — it is
 * a default, not a mandate.
 */
export async function selectDefaultStrategy(
  input: StrategySelectionInput,
): Promise<OrchestrationStrategy> {
  const { archimedesConfig, largeModelProvider, projectRoot } = input;
  if (archimedesConfig.enabled && (await isOllamaAvailable(archimedesConfig.ollamaBaseUrl))) {
    return new ArchimedesAlternatorStrategy(archimedesConfig, largeModelProvider, projectRoot);
  }
  return new SingleModelStrategy(largeModelProvider);
}
