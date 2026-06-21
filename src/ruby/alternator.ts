import { randomUUID } from 'crypto';
import type { LLMProvider } from '../providers/types.js';
import type { HistoryMessage } from '../providers/types.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { runAgentLoop } from '../agent/loop.js';
import type { LoopResult } from '../agent/loop.js';
import type { ProjectContext } from '../agent/context.js';
import { PermissionSystem } from '../safety/permissions.js';
import type { Display } from '../cli/display.js';
import type {
  AlternationDecision,
  Episode,
  RubyConfig,
  TaskCategory,
} from './types.js';
import { assessCompetence, shouldFineTune } from './competence.js';
import { episodeStore } from './episode-capture.js';
import type { EpisodeStats } from './episode-capture.js';

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for a {@link RubyAlternator} instance. */
export interface AlternatorOptions {
  rubyConfig: RubyConfig;
  largeModelProvider: LLMProvider;
  projectRoot: string;
  context: ProjectContext;
  /** When set, routing and loop events are surfaced to the user. */
  display?: Display;
  /**
   * The permission system governing the user's actual session. Pass this
   * through from the caller so Ruby's attempt respects whatever mode the
   * user chose (read-only / normal / auto) — without it, this previously
   * defaulted to a hardcoded 'auto', meaning destructive operations could
   * get silently approved during the Ruby attempt even in a session the
   * user explicitly ran in confirmation-required 'normal' mode.
   */
  permissions?: PermissionSystem;
  /**
   * Confirmation callback for destructive operations, passed through to
   * both the Ruby attempt and the large-model escalation. Pass the same
   * one the caller already uses (e.g. the REPL's readline-based prompt) —
   * without it, each inner loop falls back to its own default terminal
   * confirm(), which can behave inconsistently alongside an already-active
   * readline interface.
   */
  confirmFn?: (message: string) => Promise<boolean>;
  /**
   * Prior conversation history to resume from (e.g. the REPL's stay-active
   * history, or a loaded session). Without this, every Ruby-alternated
   * turn would silently start fresh, breaking multi-turn conversation
   * continuation any time alternation activates mid-conversation.
   */
  initialHistory?: HistoryMessage[];
}

export interface AlternatorRunResult {
  /**
   * The full result from whichever path actually produced the final
   * output — Ruby's if it succeeded without escalation, otherwise the
   * large model's. Treat this exactly like a normal runAgentLoop() result:
   * history, costUsd, turns, and toolCallLog are all populated correctly
   * from whichever path ran, so callers don't need special-case handling.
   */
  loopResult: LoopResult;
  episode: Episode;
  usedRuby: boolean;
  decision: AlternationDecision;
}

const RECENT_EPISODE_LIMIT = 50;
const OLLAMA_PING_MS = 3_000;

// ─────────────────────────────────────────────────────────────────────────────
// Display noop
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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function inferTaskCategory(task: string): TaskCategory {
  const t = task.toLowerCase();
  if (/\b(review|audit|lint|check)\b/.test(t)) return 'review';
  if (/\b(research|explore|find|investigate|understand)\b/.test(t)) return 'research';
  if (/\b(refactor|restructure|rename|migrate)\b/.test(t)) return 'refactor';
  if (/\b(implement|fix|add|write|create|build|update)\b/.test(t)) return 'implementation';
  return 'other';
}

function isNonEmptyResult(text: string | undefined): boolean {
  return typeof text === 'string' && text.trim().length > 0;
}

/**
 * Checks whether the Ollama OpenAI-compatible endpoint responds.
 * Never throws.
 */
async function isOllamaAvailable(baseUrl: string): Promise<boolean> {
  try {
    const root = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    const url = `${root}/v1/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_PING_MS);
    const res = await fetch(url, {
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

function buildRubyProvider(config: RubyConfig): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    {
      model: config.modelName,
      baseUrl: config.ollamaBaseUrl,
      apiKey: 'ollama',
    },
    'Ruby (Ollama)',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RubyAlternator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Routes tasks between the small Ruby model (Ollama) and a large model based on
 * learned competence, capturing every alternation as an {@link Episode}.
 */
export class RubyAlternator {
  private readonly opts: AlternatorOptions;
  private readonly display: Display;
  private readonly permissions: PermissionSystem;

  constructor(opts: AlternatorOptions) {
    this.opts = opts;
    this.display = opts.display ?? createNoopDisplay();
    this.permissions = opts.permissions ?? new PermissionSystem('normal');
  }

  /**
   * Runs a task through Ruby and/or the large model, persists an episode, and
   * returns the final output. Never throws — failures escalate to the large model.
   */
  async run(task: string): Promise<AlternatorRunResult> {
    const startMs = Date.now();
    const { rubyConfig, largeModelProvider, projectRoot, context } = this.opts;
    const confirmFn = this.opts.confirmFn;

    let decision: AlternationDecision = {
      useRuby: false,
      reason: 'Initializing alternation.',
      confidence: 0,
      fallbackModel: largeModelProvider.model,
    };

    let rubyAttempted = false;
    let rubySucceeded = false;
    let rubyLoopResult: LoopResult | undefined;
    let largeModelLoopResult: LoopResult | undefined;
    let usedRuby = false;
    // Only used to build the error-path fallback LoopResult below; the
    // success paths read everything from rubyLoopResult/largeModelLoopResult.
    let errorSummary: string | undefined;

    try {
      const recent = await episodeStore.loadEpisodes(projectRoot, RECENT_EPISODE_LIMIT);
      decision = assessCompetence(recent, task, rubyConfig);
      decision.fallbackModel = largeModelProvider.model;

      this.display.header('Ruby Principle', decision.reason);

      if (decision.useRuby && rubyConfig.enabled) {
        const available = await isOllamaAvailable(rubyConfig.ollamaBaseUrl);
        if (!available) {
          this.display.warning('Ruby (Ollama) is not reachable — escalating to large model.');
        } else {
          rubyAttempted = true;
          this.display.success(`Trying Ruby (${rubyConfig.modelName})…`);

          try {
            const rubyProvider = buildRubyProvider(rubyConfig);
            rubyLoopResult = await runAgentLoop({
              provider: rubyProvider,
              task,
              context,
              permissions: this.permissions,
              display: this.display,
              confirmFn,
              initialHistory: this.opts.initialHistory,
              disableSpawn: true,
              maxTurns: 15,
            });

            if (isNonEmptyResult(rubyLoopResult.summary) && rubyLoopResult.success) {
              rubySucceeded = true;
              usedRuby = true;
              this.display.success('Ruby handled the task without escalation.');
            } else {
              this.display.warning('Ruby did not produce a usable result — escalating.');
            }
          } catch (e) {
            this.display.warning(`Ruby error: ${String(e)} — escalating.`);
          }
        }
      }

      if (!usedRuby) {
        this.display.header('Large model', largeModelProvider.name);
        try {
          largeModelLoopResult = await runAgentLoop({
            provider: largeModelProvider,
            task,
            context,
            permissions: this.permissions,
            display: this.display,
            confirmFn,
            initialHistory: this.opts.initialHistory,
            disableSpawn: true,
          });
        } catch (e) {
          errorSummary = `Large model error: ${String(e)}`;
          this.display.error(errorSummary);
        }
      }
    } catch (e) {
      errorSummary = `Alternation error: ${String(e)}`;
      this.display.error(errorSummary);
    }

    // The full result that actually represents this run's output — Ruby's
    // if it succeeded, otherwise the large model's, otherwise a safe empty
    // result for the case where something threw before either path ran.
    const finalLoopResult: LoopResult = usedRuby
      ? rubyLoopResult!
      : largeModelLoopResult ?? {
          success: false,
          summary: errorSummary ?? 'Alternation failed before either model ran.',
          turns: 0,
          toolCallCount: 0,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          costUsd: 0,
          history: [],
          toolCallLog: [],
        };

    const episode: Episode = {
      id: randomUUID(),
      timestamp: Date.now(),
      task,
      projectRoot,
      rubyAttempted,
      rubySucceeded,
      rubyOutput: rubyLoopResult?.summary,
      largeModelUsed: usedRuby ? undefined : largeModelProvider.model,
      largeModelOutput: usedRuby ? undefined : largeModelLoopResult?.summary,
      reviewerApproved: isNonEmptyResult(finalLoopResult.summary) && finalLoopResult.success,
      tokensUsed: {
        ruby: rubyAttempted ? rubyLoopResult?.usage.totalTokens : undefined,
        largeModel: usedRuby ? undefined : largeModelLoopResult?.usage.totalTokens,
      },
      durationMs: Date.now() - startMs,
      taskCategory: inferTaskCategory(task),
    };

    try {
      await episodeStore.saveEpisode(projectRoot, episode);
    } catch (e) {
      this.display.warning(`Failed to save episode: ${String(e)}`);
    }

    try {
      const all = await episodeStore.loadEpisodes(projectRoot);
      if (shouldFineTune(all)) {
        this.display.warning(
          'Ruby Principle: enough failures accumulated — project is ready for fine-tuning.',
        );
      }
    } catch {
      /* best-effort */
    }

    return { loopResult: finalLoopResult, episode, usedRuby, decision };
  }

  /**
   * Returns aggregate episode statistics for this alternator's project.
   * Never throws.
   */
  async getStats(): Promise<EpisodeStats> {
    return episodeStore.getEpisodeStats(this.opts.projectRoot);
  }
}