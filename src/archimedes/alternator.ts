import { randomUUID } from 'crypto';
import type { HistoryMessage, LLMProvider } from '../providers/types.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { runAgentLoop, type LoopResult } from '../agent/loop.js';
import type { ProjectContext } from '../agent/context.js';
import { PermissionSystem } from '../safety/permissions.js';
import type { Display } from '../cli/display.js';
import type { ContextHealthTracker } from '../cli/context-health.js';
import type { SessionBudget } from '../agent/session-budget.js';
import { runCouncil } from '../research/council.js';
import type {
  AlternationDecision,
  Episode,
  ArchimedesConfig,
  TaskCategory,
} from './types.js';
import { assessCompetence, shouldFineTune } from './competence.js';
import { resolveEndpoint, wireModelName } from './endpoint.js';
import { episodeStore } from './episode-capture.js';
import type { EpisodeStats } from './episode-capture.js';

// Tools sent to the Archimedes attempt — read-only subset only.
// Mutating tools (edit_file, write_file, run_shell) are already blocked by the
// PermissionSystem, but stripping them from the schema saves schema tokens on
// every one of Archimedes's turns without touching the large-model escalation.
const ARCHIMEDES_TOOLS = ['read_file', 'list_dir', 'search_code', 'search_semantic'];

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
  /**
   * Manual override (`:small1`): always start with Archimedes, bypassing the
   * competence gate. Verification and escalation still run afterwards, and the
   * episode is recorded normally — a forced attempt is what lets a frozen
   * competence score move again.
   */
  forceArchimedes?: boolean;
  /**
   * Turn budget for the Archimedes attempt (from the session's --max-turns /
   * config). Only ever tightens the built-in cap of 15 — an explicit wider
   * budget is meant for the trusted large model, not the unproven local one.
   */
  maxTurns?: number;
  /**
   * Session budget for cost control. Respected by Archimedes attempt and any
   * council escalation. Required for design-task council escalation to work.
   */
  sessionBudget?: SessionBudget;
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
 * Default probability of overriding a gated (useArchimedes: false) decision and
 * letting Archimedes attempt anyway. Without this, `assessCompetence` gates a task
 * pattern once its success rate drops below threshold, and — because
 * `archimedesAttempted` only becomes true inside the `decision.useArchimedes` branch —
 * that pattern's score then never updates again. The gate becomes
 * permanent even if the underlying model improves. This periodic probe
 * keeps the score live. Kept low: the probe still pays full Archimedes-then-large-
 * model cost on every trial (verification always runs), so it should not be
 * confused with a free background check. Override per project via
 * `archimedes.epsilonProbeRate` in .aura.json.
 */
const DEFAULT_EPSILON_PROBE_RATE = 0.05;

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

/**
 * Classifies task mode for verification: retrieval (fact-checking against tool
 * evidence) or design (allows novel proposals). Built on top of
 * inferTaskCategory but maps to the verification axis.
 */
function taskMode(task: string): 'retrieval' | 'design' {
  const cat = inferTaskCategory(task);
  if (cat === 'review' || cat === 'research') return 'retrieval';
  if (cat === 'refactor' || cat === 'implementation') return 'design';
  // For 'other', check for design-indicating phrases
  if (/\b(proposal|design|approach|solution|strategy|architecture|how should we|way to|suggest|recommend|improve|optimize|plan|rethink|how would|what'?s the best)\b/i.test(task)) {
    return 'design';
  }
  return 'retrieval'; // default to safer mode
}

function isNonEmptyResult(text: string | undefined): boolean {
  return typeof text === 'string' && text.trim().length > 0;
}

/**
 * Checks whether the configured local endpoint (Ollama or LM Studio) responds.
 * Both serve an OpenAI-compatible `/v1/models`, so one probe covers either.
 * Never throws.
 */
async function isLocalBackendAvailable(config: ArchimedesConfig): Promise<boolean> {
  const endpoint = resolveEndpoint(config);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_PING_MS);
    const res = await fetch(`${endpoint.baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${endpoint.apiKey}` },
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
 *
 * Verification rubric branches by task mode (retrieval vs design):
 * - Retrieval tasks: strict tool-evidence corroboration (original behavior)
 * - Design tasks: factual premises still strict, recommendations judged on coherence/relevance
 */
async function verifyArchimedesAnswer(
  task: string,
  answer: string,
  history: HistoryMessage[],
  verifierProvider: LLMProvider,
): Promise<ArchimedesVerification> {
  const toolSummary = summarizeToolActivity(history);
  const mode = taskMode(task);

  const prompt = mode === 'retrieval' ? [
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
  ].join('\n') : [
    `Task: ${task}`,
    ``,
    `Tools Archimedes actually called and what they returned:`,
    toolSummary,
    ``,
    `Archimedes's final answer:`,
    answer,
    ``,
    `This is a design/refactor/implementation task. Check the answer in two parts:`,
    ``,
    `PART 1 — Factual premises (must still be STRICT):`,
    `Does the answer describe current state (files, functions, structure, behavior) in ways`,
    `that contradict tool evidence? If tools say something was not found or doesn't exist,`,
    `but the answer describes it in detail as if it does, that is fabrication and must be`,
    `marked INVALID regardless of how good the proposal is.`,
    ``,
    `PART 2 — The proposal (different criteria):`,
    `Since this is a design task, Archimedes is allowed to propose changes not currently in`,
    `the codebase. Judge the recommendation on:`,
    `- Does it address the task?`,
    `- Is it internally coherent?`,
    `- Does it demonstrate understanding of current state (even if not fully corroborated)?`,
    `- Does it acknowledge tradeoffs or constraints?`,
    `- Does it contradict known hard constraints from tool evidence?`,
    ``,
    `Reply with exactly one line: either "VALID" or "INVALID: <short reason, specify which part failed>".`,
  ].join('\n');

  try {
    const systemMsg = mode === 'retrieval'
      ? 'You are a strict factual verifier. Check the answer against tool evidence for contradictions and fabrications. Reply with exactly one line.'
      : 'You are a strict verifier for a design task. Factual claims about current state must match tool evidence (Part 1), but novel proposals are judged on coherence and relevance (Part 2). Reply with exactly one line.';
    const response = await verifierProvider.complete(
      systemMsg,
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
  const endpoint = resolveEndpoint(config);
  return new OpenAICompatibleProvider(
    {
      model: wireModelName(config),
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
    },
    `Archimedes (${endpoint.label})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ArchimedesAlternator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Routes tasks between the small Archimedes model (local Ollama or LM Studio)
 * and a large model based on
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

      // Manual override (:small1): start with Archimedes regardless of the gate.
      // Applied before the epsilon probe so a forced session never depends on
      // the dice roll; verification/escalation below is untouched.
      if (this.opts.forceArchimedes && !decision.useArchimedes) {
        const score = decision.competenceLevel
          ? `${(decision.competenceLevel.successRate * 100).toFixed(0)}%`
          : 'no recorded attempts';
        decision = {
          ...decision,
          useArchimedes: true,
          reason: `Starting with Archimedes (small1 override — competence gate bypassed, current score: ${score}).`,
        };
      }

      // Epsilon probe: a gated pattern (useArchimedes: false) would otherwise never
      // get another `archimedesAttempted: true` episode, freezing its score
      // permanently (see DEFAULT_EPSILON_PROBE_RATE doc comment above). Roll the die
      // only when the gate actually fired — a pattern still in its
      // minAttempts learning phase is already using Archimedes and needs no probe.
      const epsilon = archimedesConfig.epsilonProbeRate ?? DEFAULT_EPSILON_PROBE_RATE;
      if (!decision.useArchimedes && archimedesConfig.enabled && Math.random() < epsilon) {
        decision = {
          ...decision,
          useArchimedes: true,
          reason: `[probe] Overriding gate to re-test competence — ${decision.reason}`,
        };
      }

      this.display.header('Archimedes Principle', decision.reason);

      if (decision.useArchimedes && (archimedesConfig.enabled || this.opts.forceArchimedes)) {
        const endpoint = resolveEndpoint(archimedesConfig);
        const available = await isLocalBackendAvailable(archimedesConfig);
        if (!available) {
          this.display.warning(
            `Archimedes (${endpoint.label} at ${endpoint.baseUrl}) is not reachable — escalating to large model.`,
          );
        } else {
          archimedesAttempted = true;
          this.display.success(`Trying Archimedes (${wireModelName(archimedesConfig)} on ${endpoint.label})…`);

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
              maxTurns: Math.min(this.opts.maxTurns ?? 15, 15),
              confirmFn: this.opts.confirmFn,
              initialHistory: this.opts.initialHistory,
              abortSignal: this.opts.abortSignal,
              healthTracker: this.opts.healthTracker,
              allowedTools: ARCHIMEDES_TOOLS,
              maxRepetitionsPerTool: 3,
              toolResultMaxChars: 1_500,
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
            maxTurns: this.opts.maxTurns,
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

          // Council escalation for design tasks: if large model output fails verification,
          // run a design council to get divergent solution proposals.
          const mode = taskMode(task);
          if (mode === 'design' && isNonEmptyResult(largeModelOutput) && this.opts.sessionBudget) {
            const largeModelVerification = await verifyArchimedesAnswer(
              task,
              largeModelOutput!,
              loopResult.history,
              largeModelProvider,
            );

            if (!largeModelVerification.valid) {
              this.display.warning(
                `Large model answer failed verification (${largeModelVerification.reason}) — checking council escalation…`,
              );

              // Rough estimate: 5 panel agents × 6 turns × 2k tokens + synthesis × 2k = ~62k tokens
              // Conservative pad to 80k for prompt scaffolding and edge cases
              const ESTIMATED_COUNCIL_TOKENS = 80_000;
              const budgetCheck = this.opts.sessionBudget.wouldExceed(ESTIMATED_COUNCIL_TOKENS);

              if (budgetCheck) {
                this.display.warning(
                  `Council would exceed session budget (${budgetCheck.used.toLocaleString()} / ${budgetCheck.limit.toLocaleString()} tokens) — skipping escalation.`,
                );
              } else {
                // Gap 4: Confirm with user before expensive 5-agent council.
                // Budget check is necessary but not sufficient — 80k tokens
                // within budget is still expensive if the user didn't ask for it.
                const confirmFn = this.opts.confirmFn;
                const userConfirmed = confirmFn
                  ? await confirmFn(
                      `Large model answer failed verification. Run a 5-agent design council (~${(ESTIMATED_COUNCIL_TOKENS / 1000).toFixed(0)}k tokens)?`,
                    )
                  : false; // no confirmFn = non-interactive context, skip council

                if (!userConfirmed) {
                  this.display.warning('Council escalation declined — using large model output.');
                } else {
                  // Gap 5: Pass the failed attempt so council agents don't repeat
                  // the same factual errors that got the large model rejected.
                  const failedAttemptContext = [
                    `A previous attempt at this task failed verification: ${largeModelVerification.reason}`,
                    ``,
                    `Previous attempt's tool activity:`,
                    summarizeToolActivity(loopResult.history),
                    ``,
                    `Previous (invalid) answer, for reference — verify independently:`,
                    largeModelOutput!,
                  ].join('\n');

                  this.display.header('Design council', 'Running 5-agent design council for divergent solutions…');
                  try {
                    const councilResult = await runCouncil({
                      projectRoot,
                      topic: task,
                      synthesisProvider: largeModelProvider,
                      context,
                      permissions: this.permissions,
                      display: this.display,
                      panelSize: 5,
                      mode: 'design',
                      failedAttemptContext,
                      budget: this.opts.sessionBudget,
                    });

                    // Read the synthesized verdict from the council output
                    const councilMd = await import('fs').then(fs => fs.promises.readFile(councilResult.path, 'utf-8'));
                    // Extract the synthesis sections (everything before "Raw panel proposals")
                    const synthesisMatch = councilMd.match(/[\s\S]+?(?=---\n\n## Raw panel proposals)/);
                    let councilAnswer = synthesisMatch
                      ? synthesisMatch[0].trim()
                      : councilMd;

                    // Gap 6: Re-verify council output for factual accuracy.
                    // The synthesis could contain fabrications from panel agents.
                    // Use retrieval mode — proposals are expected to be novel,
                    // but factual claims must still be checkable.
                    const councilVerification = await verifyArchimedesAnswer(
                      task,
                      councilAnswer,
                      loopResult.history, // original tool evidence is the ground truth
                      largeModelProvider,
                    );

                    if (councilVerification.valid) {
                      result = councilAnswer;
                      finalLoopResult = {
                        ...loopResult,
                        summary: result,
                      };
                      this.display.success(`Design council completed — verdict saved to ${councilResult.path}`);
                    } else {
                      this.display.warning(
                        `Council output also failed verification (${councilVerification.reason}) — using large model output.`,
                      );
                    }
                  } catch (e) {
                    this.display.error(`Council error: ${String(e)} — using large model output.`);
                  }
                }
              }
            }
          }
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