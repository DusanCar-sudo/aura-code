import { randomUUID } from 'crypto';
import type { LLMProvider } from '../providers/types.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { runAgentLoop } from '../agent/loop.js';
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
}

export interface AlternatorRunResult {
  result: string;
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
  private readonly permissions = new PermissionSystem('auto');

  constructor(opts: AlternatorOptions) {
    this.opts = opts;
    this.display = opts.display ?? createNoopDisplay();
  }

  /**
   * Runs a task through Ruby and/or the large model, persists an episode, and
   * returns the final output. Never throws — failures escalate to the large model.
   */
  async run(task: string): Promise<AlternatorRunResult> {
    const startMs = Date.now();
    const { rubyConfig, largeModelProvider, projectRoot, context } = this.opts;

    let decision: AlternationDecision = {
      useRuby: false,
      reason: 'Initializing alternation.',
      confidence: 0,
      fallbackModel: largeModelProvider.model,
    };

    let rubyAttempted = false;
    let rubySucceeded = false;
    let rubyOutput: string | undefined;
    let rubyTokens = 0;
    let largeModelOutput: string | undefined;
    let largeModelTokens = 0;
    let usedRuby = false;
    let result = '';

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
            const loopResult = await runAgentLoop({
              provider: rubyProvider,
              task,
              context,
              permissions: this.permissions,
              display: this.display,
              disableSpawn: true,
              maxTurns: 15,
            });

            rubyTokens = loopResult.usage.totalTokens;
            rubyOutput = loopResult.summary;

            if (isNonEmptyResult(rubyOutput) && loopResult.success) {
              rubySucceeded = true;
              usedRuby = true;
              result = rubyOutput!;
              this.display.success('Ruby handled the task without escalation.');
            } else {
              this.display.warning('Ruby did not produce a usable result — escalating.');
            }
          } catch (e) {
            this.display.warning(`Ruby error: ${String(e)} — escalating.`);
            rubyOutput = rubyOutput ?? `Error: ${String(e)}`;
          }
        }
      }

      if (!usedRuby) {
        this.display.header('Large model', largeModelProvider.name);
        try {
          const loopResult = await runAgentLoop({
            provider: largeModelProvider,
            task,
            context,
            permissions: this.permissions,
            display: this.display,
            disableSpawn: true,
          });
          largeModelTokens = loopResult.usage.totalTokens;
          largeModelOutput = loopResult.summary;
          result = isNonEmptyResult(largeModelOutput)
            ? largeModelOutput!
            : loopResult.success
              ? '(Task completed with no output)'
              : `Large model did not complete: ${loopResult.summary}`;
        } catch (e) {
          result = `Large model error: ${String(e)}`;
          largeModelOutput = result;
          this.display.error(result);
        }
      }
    } catch (e) {
      result = `Alternation error: ${String(e)}`;
      this.display.error(result);
    }

    const episode: Episode = {
      id: randomUUID(),
      timestamp: Date.now(),
      task,
      projectRoot,
      rubyAttempted,
      rubySucceeded,
      rubyOutput,
      largeModelUsed: usedRuby ? undefined : largeModelProvider.model,
      largeModelOutput: usedRuby ? undefined : largeModelOutput,
      reviewerApproved: isNonEmptyResult(result),
      tokensUsed: {
        ruby: rubyAttempted ? rubyTokens : undefined,
        largeModel: usedRuby ? undefined : largeModelTokens,
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

    return { result, episode, usedRuby, decision };
  }

  /**
   * Returns aggregate episode statistics for this alternator's project.
   * Never throws.
   */
  async getStats(): Promise<EpisodeStats> {
    return episodeStore.getEpisodeStats(this.opts.projectRoot);
  }
}