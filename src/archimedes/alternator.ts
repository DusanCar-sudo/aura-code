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
  ArchimedesConfig,
  TaskCategory,
} from './types.js';
import { assessCompetence, shouldFineTune } from './competence.js';
import { episodeStore } from './episode-capture.js';
import type { EpisodeStats } from './episode-capture.js';

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for a {@link ArchimedesAlternator} instance. */
export interface AlternatorOptions {
  archimedesConfig: ArchimedesConfig;
  largeModelProvider: LLMProvider;
  projectRoot: string;
  context: ProjectContext;
  /** When set, routing and loop events are surfaced to the user. */
  display?: Display;
  /**
   * The session's permission system. When omitted, defaults to the safe
   * 'normal' level — NEVER 'auto': the Archimedes attempt must not auto-approve
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
  usedArchimedes: boolean;
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

/**
 * Probability of overriding a gated (useArchimedes: false) decision and letting
 * Archimedes attempt anyway. Without this, `assessCompetence` gates a task
 * pattern once its success rate drops below threshold, and — because
 * `archimedesAttempted` only becomes true inside the `decision.useArchimedes` branch —
 * that pattern's score then never updates again. The gate becomes
 * permanent even if the underlying model improves. This periodic probe
 * keeps the score live. Kept low: the probe still pays full Archimedes-then-large-
 * model cost on every trial (verification always runs), so it should not be
 * confused with a free background check.
 */
const EPSILON_PROBE_RATE = 0.05;

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

interface ArchimedesVerification {
  valid: boolean;
  reason: string;
}

/**
 * Condense Archimedes's tool activity from loop history into a short, cheap summary
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
 * Cheap correctness gate on Archimedes's answer: one `complete()` call to the large
 * model with no tools and no history — deliberately NOT a full agent loop.
 * Fail-safe: any verification error counts as invalid (escalate), never as
 * silent trust.
 */
async function verifyArchimedesAnswer(
  task: string,
  answer: string,
  history: HistoryMessage[],
  verifierProvider: LLMProvider,
): Promise<ArchimedesVerification> {
  const toolSummary = summarizeToolActivity(history);

  const prompt = [
    `Task: ${task}`,
    ``,
    `Tools Archimedes actually called and what they returned:`,
    toolSummary,
    ``,
    `Archimedes's final answer:`,
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

function buildArchimedesProvider(config: ArchimedesConfig): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    {
      model: config.modelName,
      baseUrl: config.ollamaBaseUrl,
      apiKey: 'ollama',
    },
    'Archimedes (Ollama)',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ArchimedesAlternator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Routes tasks between the small Archimedes model (Ollama) and a large model based on
 * learned competence, capturing every alternation as an {@link Episode}.
 */
export class ArchimedesAlternator {
  private readonly opts: AlternatorOptions;
  private readonly display: Display;
  private readonly permissions: PermissionSystem;

  constructor(opts: AlternatorOptions) {
    this.opts = opts;
    this.display = opts.display ?? createNoopDisplay();
    this.permissions = opts.permissions ?? new PermissionSystem('normal');
  }

  /**
   * Runs a task through Archimedes and/or the large model, persists an episode, and
   * returns the final output. Never throws — failures escalate to the large model.
   */
  async run(task: string): Promise<AlternatorRunResult> {
    const startMs = Date.now();
    const { archimedesConfig, largeModelProvider, projectRoot, context } = this.opts;

    let decision: AlternationDecision = {
      useArchimedes: false,
      reason: 'Initializing alternation.',
      confidence: 0,
      fallbackModel: largeModelProvider.model,
    };

    let archimedesAttempted = false;
    let archimedesSucceeded = false;
    let archimedesOutput: string | undefined;
    let archimedesTokens = 0;
    let largeModelOutput: string | undefined;
    let largeModelTokens = 0;
    let usedArchimedes = false;
    let result = '';
    let finalLoopResult: LoopResult | undefined;
    // Populated whenever Archimedes is attempted and fails/errors, so the escalation
    // call isn't blind to what Archimedes already tried. Never fed back into the
    // Episode — only into the large model's task text for this run.
    let archimedesFailureContext: string | undefined;

    try {
      const recent = await episodeStore.loadEpisodes(projectRoot, RECENT_EPISODE_LIMIT);
      decision = assessCompetence(recent, task, archimedesConfig);
      decision.fallbackModel = largeModelProvider.model;

      // Epsilon probe: a gated pattern (useArchimedes: false) would otherwise never
      // get another `archimedesAttempted: true` episode, freezing its score
      // permanently (see EPSILON_PROBE_RATE doc comment above). Roll the die
      // only when the gate actually fired — a pattern still in its
      // minAttempts learning phase is already using Archimedes and needs no probe.
      if (!decision.useArchimedes && archimedesConfig.enabled && Math.random() < EPSILON_PROBE_RATE) {
        decision = {
          ...decision,
          useArchimedes: true,
          reason: `[probe] Overriding gate to re-test competence — ${decision.reason}`,
        };
      }

      this.display.header('Archimedes Principle', decision.reason);

      if (decision.useArchimedes && archimedesConfig.enabled) {
        const available = await isOllamaAvailable(archimedesConfig.ollamaBaseUrl);
        if (!available) {
          this.display.warning('Archimedes (Ollama) is not reachable — escalating to large model.');
        } else {
          archimedesAttempted = true;
          this.display.success(`Trying Archimedes (${archimedesConfig.modelName})…`);

          try {
            const archimedesProvider = buildArchimedesProvider(archimedesConfig);
            const loopResult = await runAgentLoop({
              provider: archimedesProvider,
              task,
              context,
              // Archimedes is unproven — it must never inherit the session's write
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

            archimedesTokens = loopResult.usage.totalTokens;
            archimedesOutput = loopResult.summary;

            if (isNonEmptyResult(archimedesOutput) && loopResult.success) {
              const verification = await verifyArchimedesAnswer(
                task,
                archimedesOutput!,
                loopResult.history,
                largeModelProvider,
              );
              if (verification.valid) {
                archimedesSucceeded = true;
                usedArchimedes = true;
                result = archimedesOutput!;
                finalLoopResult = loopResult;
                this.display.success('Archimedes handled the task without escalation.');
              } else {
                archimedesFailureContext = [
                  `Archimedes's answer failed verification: ${verification.reason}`,
                  ``,
                  `Archimedes's tool activity:`,
                  summarizeToolActivity(loopResult.history),
                  ``,
                  `Archimedes's (invalid) answer, for reference only — verify independently:`,
                  archimedesOutput!,
                ].join('\n');
                this.display.warning(
                  `Archimedes's answer failed verification (${verification.reason}) — escalating.`,
                );
              }
            } else {
              archimedesFailureContext = [
                loopResult.success
                  ? `Archimedes produced no usable output.`
                  : `Archimedes did not complete the task (${loopResult.summary}).`,
                ``,
                `Archimedes's tool activity:`,
                summarizeToolActivity(loopResult.history),
              ].join('\n');
              this.display.warning('Archimedes did not produce a usable result — escalating.');
            }
          } catch (e) {
            this.display.warning(`Archimedes error: ${String(e)} — escalating.`);
            archimedesOutput = archimedesOutput ?? `Error: ${String(e)}`;
            archimedesFailureContext = `Archimedes errored before producing output: ${String(e)}`;
          }
        }
      }

      if (!usedArchimedes) {
        this.display.header('Large model', largeModelProvider.name);
        // If Archimedes already tried and failed, hand its attempt to the large
        // model instead of letting it re-discover the same dead end. The
        // Episode still records the original `task` — this augmented
        // version is only used for this run.
        const largeModelTask = archimedesFailureContext
          ? [
              task,
              ``,
              `---`,
              `Note: a smaller local model (Archimedes) already attempted this task`,
              `and failed. Use the following as context on what NOT to repeat —`,
              `it is not verified and may itself be wrong or incomplete:`,
              archimedesFailureContext,
              `---`,
            ].join('\n')
          : task;
        try {
          const loopResult = await runAgentLoop({
            provider: largeModelProvider,
            task: largeModelTask,
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
      archimedesAttempted,
      archimedesSucceeded,
      archimedesOutput,
      largeModelUsed: usedArchimedes ? undefined : largeModelProvider.model,
      largeModelOutput: usedArchimedes ? undefined : largeModelOutput,
      reviewerApproved: isNonEmptyResult(result),
      tokensUsed: {
        archimedes: archimedesAttempted ? archimedesTokens : undefined,
        largeModel: usedArchimedes ? undefined : largeModelTokens,
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
          'Archimedes Principle: enough failures accumulated — project is ready for fine-tuning.',
        );
      }
    } catch {
      /* best-effort */
    }

    return {
      result,
      loopResult: finalLoopResult ?? emptyLoopResult(result),
      episode,
      usedArchimedes,
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