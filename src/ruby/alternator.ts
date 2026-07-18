import { randomUUID } from 'crypto';
import type { HistoryMessage, LLMProvider } from '../providers/types.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { runAgentLoop, type LoopResult } from '../agent/loop.js';
import type { ProjectContext } from '../agent/context.js';
import { PermissionSystem } from '../safety/permissions.js';
import type { Display } from '../cli/display.js';
import type { ContextHealthTracker } from '../cli/context-health.js';
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
   * The session's permission system. When omitted, defaults to the safe
   * 'normal' level — NEVER 'auto': the Ruby attempt must not auto-approve
   * destructive operations the user's chosen mode would have prompted for.
   */
  permissions?: PermissionSystem;
  /** Confirmation prompt for needs-confirm tool calls, threaded into the loop. */
  confirmFn?: (message: string) => Promise<boolean>;
  /** Prior conversation history (multi-turn REPL), threaded into the loop. */
  initialHistory?: HistoryMessage[];
  /** Abort signal (REPL Ctrl+C / :stop) — forwarded to both inner agent loops. */
  abortSignal?: AbortSignal;
  /** Shared context-health tracker (the REPL's) — forwarded to both inner agent loops. */
  healthTracker?: ContextHealthTracker;
}

export interface AlternatorRunResult {
  /** Final user-facing output text (loopResult.summary, or an error note). */
  result: string;
  /** The full LoopResult from whichever model handled the task. Never undefined —
   *  a safe empty result is substituted when every path failed. */
  loopResult: LoopResult;
  episode: Episode;
  usedRuby: boolean;
  decision: AlternationDecision;
}

/** Inert LoopResult for the both-paths-failed case — run() never throws. */
function emptyLoopResult(summary: string): LoopResult {
  return {
    success: false,
    summary,
    turns: 0,
    toolCallCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 },
    costUsd: 0,
    history: [],
    toolCallLog: [],
  };
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
    contextBar: () => {},
    contextDashboard: () => {},
    compactionEvent: () => {},
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

interface RubyVerification {
  valid: boolean;
  reason: string;
}

/**
 * Condense Ruby's tool activity from loop history into a short, cheap summary
 * for the verifier. The toolCallLog on LoopResult only records name+input, so
 * actual outputs are pulled from `tool_result` history entries; args come from
 * the matching assistant toolCalls (paired by id). Each result is truncated so
 * the verification call stays one cheap prompt, not a transcript dump.
 */
function summarizeToolActivity(history: HistoryMessage[]): string {
  const MAX_RESULT_CHARS = 300;
  const argsById = new Map<string, string>();
  for (const msg of history) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        let args = JSON.stringify(call.input);
        if (args.length > 120) args = args.slice(0, 120) + '…';
        argsById.set(call.id, args);
      }
    }
  }

  const lines: string[] = [];
  for (const msg of history) {
    if (msg.role !== 'tool_result') continue;
    for (const r of msg.results) {
      let content = r.content.replace(/\s+/g, ' ').trim();
      if (content.length > MAX_RESULT_CHARS) {
        content = content.slice(0, MAX_RESULT_CHARS) + '…';
      }
      lines.push(`- ${r.name}(${argsById.get(r.id) ?? ''}) -> ${content}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(no tools were called)';
}

/**
 * Cheap correctness gate on Ruby's answer: one `complete()` call to the large
 * model with no tools and no history — deliberately NOT a full agent loop.
 * Fail-safe: any verification error counts as invalid (escalate), never as
 * silent trust.
 */
async function verifyRubyAnswer(
  task: string,
  answer: string,
  history: HistoryMessage[],
  verifierProvider: LLMProvider,
): Promise<RubyVerification> {
  const toolSummary = summarizeToolActivity(history);

  const prompt = [
    `Task: ${task}`,
    ``,
    `Tools Ruby actually called and what they returned:`,
    toolSummary,
    ``,
    `Ruby's final answer:`,
    answer,
    ``,
    `Does this answer correctly and completely address the task?`,
    `Critically: check the answer against the tool results above for`,
    `direct contradictions — for example, if a tool result says a`,
    `function/file/symbol was not found, but the answer describes it`,
    `in detail as if it exists, that is a fabrication and must be`,
    `marked INVALID regardless of how complete or well-written the`,
    `answer looks.`,
    `Reply with exactly one line: either "VALID" or "INVALID: <short reason>".`,
  ].join('\n');

  try {
    const response = await verifierProvider.complete(
      'You are a strict verifier. Judge only whether the proposed answer addresses the task. Reply with exactly one line.',
      [{ role: 'user', content: prompt }],
      [],
    );
    const text = response.text.trim();
    if (text.toUpperCase().startsWith('VALID')) {
      return { valid: true, reason: '' };
    }
    const reason = text.replace(/^INVALID:?\s*/i, '') || 'failed verification';
    return { valid: false, reason };
  } catch (e) {
    return { valid: false, reason: `verification error: ${String(e)}` };
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
    let finalLoopResult: LoopResult | undefined;

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
              // Ruby is unproven — it must never inherit the session's write
              // access (with --auto it once wrote garbage into a real source
              // file on an informational task). Always read-only, independent
              // of session permissions, until competence tracking proves it.
              permissions: new PermissionSystem('read-only'),
              display: this.display,
              disableSpawn: true,
              maxTurns: 15,
              confirmFn: this.opts.confirmFn,
              initialHistory: this.opts.initialHistory,
              abortSignal: this.opts.abortSignal,
              healthTracker: this.opts.healthTracker,
            });

            rubyTokens = loopResult.usage.totalTokens;
            rubyOutput = loopResult.summary;

            if (isNonEmptyResult(rubyOutput) && loopResult.success) {
              const verification = await verifyRubyAnswer(
                task,
                rubyOutput!,
                loopResult.history,
                largeModelProvider,
              );
              if (verification.valid) {
                rubySucceeded = true;
                usedRuby = true;
                result = rubyOutput!;
                finalLoopResult = loopResult;
                this.display.success('Ruby handled the task without escalation.');
              } else {
                this.display.warning(
                  `Ruby's answer failed verification (${verification.reason}) — escalating.`,
                );
              }
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
            confirmFn: this.opts.confirmFn,
            initialHistory: this.opts.initialHistory,
            abortSignal: this.opts.abortSignal,
            healthTracker: this.opts.healthTracker,
          });
          largeModelTokens = loopResult.usage.totalTokens;
          largeModelOutput = loopResult.summary;
          finalLoopResult = loopResult;
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

    return {
      result,
      loopResult: finalLoopResult ?? emptyLoopResult(result),
      episode,
      usedRuby,
      decision,
    };
  }

  /**
   * Returns aggregate episode statistics for this alternator's project.
   * Never throws.
   */
  async getStats(): Promise<EpisodeStats> {
    return episodeStore.getEpisodeStats(this.opts.projectRoot);
  }
}