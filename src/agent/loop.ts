import * as path from 'path';
import type { LLMProvider, HistoryMessage, ToolCall, ToolResult } from '../providers/types.js';
import { selectTools, executeTool } from '../tools/index.js';
import { PermissionSystem } from '../safety/permissions.js';
import { confirm } from '../safety/permissions.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { ProjectContext } from './context.js';
import type { Display } from '../cli/display.js';
import { sessionStore } from './session-store.js';
import { registerSpawner, clearSpawner, makeDefaultSpawner } from './spawner.js';
import type { VerificationConfig } from '../verify/types.js';
import { getLoopProfile, detectStall, type LoopProfile, type StallKind } from './loop-profile.js';
import { createCheckpoint, pruneCheckpoints } from '../checkpoints/engine.js';
import { DEFAULTS } from '../config/defaults.js';
import { MUTATING_TOOLS, ExecutiveQueue } from './executive-queue.js';
import { compactHistory, estimateContextTokens, getRecapGeneration, ROLLOVER_AT_GENERATION } from './compactor.js';
import { maybeRollover } from './generational-flush.js';
import { detectFrustration } from './affect.js';
import { ContextHealthTracker } from '../cli/context-health.js';

export interface LoopOptions {
  provider: LLMProvider;
  task: string;
  context: ProjectContext;
  permissions: PermissionSystem;
  display: Display;
  maxTurns?: number;
  /** Optional model id for token pricing — falls back to provider.model */
  pricingModel?: string;
  /** Path to a session file to persist history to; undefined = ephemeral */
  sessionPath?: string;
  /** Pre-existing conversation history to resume from (e.g. loaded session). */
  initialHistory?: HistoryMessage[];
  /** Base config passed to spawned sub-agents. If undefined, spawn_task returns an error. */
  spawnConfig?: { apiKey?: string; baseUrl?: string };
  /** Disables subagent tool entirely (e.g. for tests) */
  disableSpawn?: boolean;
  /** Internal: skip post-task verification (used by runWithVerification wrapper). */
  verify?: boolean;
  /** Shadow-git checkpoints before mutating tool calls (default: true; no-op outside a git repo). */
  checkpoints?: boolean;
  /** Plugin hooks fired around tool execution (PreToolUse can block). */
  hooks?: import('../plugins/types.js').HookEntry[];
  /** Optional abort signal — when aborted the loop stops after the current tool turn. */
  abortSignal?: AbortSignal;
  /** Confirmation prompt override for needs-confirm tool calls. Defaults to the
   *  terminal readline confirm — embedded callers (alternator, bots) supply
   *  their own so confirmation isn't silently impossible off-terminal. */
  confirmFn?: (message: string) => Promise<boolean>;
  /** Optional shared context-health tracker (e.g. the REPL's). When omitted the
   *  loop creates an internal one. Passing it in lets a /context command read
   *  the accumulated compaction history and per-turn snapshots. */
  healthTracker?: import('../cli/context-health.js').ContextHealthTracker;
}

export interface LoopResult {
  success: boolean;
  summary: string;
  turns: number;
  toolCallCount: number;
  usage: TokenUsage;
  costUsd: number;
  /** Full conversation history after the loop (including prior turns if resumed). */
  history: HistoryMessage[];
  /** Every tool call made during this loop run — used by the verify layer. */
  toolCallLog: Array<{ name: string; input: Record<string, unknown> }>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

const PRICING_USD_PER_MTOK: Record<string, { in: number; out: number; cachedIn?: number }> = {
  'claude-opus-4-5-20251001':   { in: 15,  out: 75  },
  'claude-sonnet-4-5-20251001': { in: 3,   out: 15  },
  'claude-haiku-4-5-20251001':  { in: 0.8, out: 4   },
  'gpt-4o':                     { in: 2.5, out: 10  },
  'gpt-4o-mini':                { in: 0.15,out: 0.6 },
  'gemini-2.5-pro':             { in: 1.25,out: 10  },
  'gemini-2.5-flash':           { in: 0.075,out: 0.3},
  'grok-beta':                  { in: 5,   out: 15  },
  // Zhipu publishes GLM-5 rates only; 5.1/5.2 assumed equal until announced.
  'glm-5.2':                    { in: 1,   out: 3.2 },
  'glm-5.1':                    { in: 1,   out: 3.2 },
  'glm-5':                      { in: 1,   out: 3.2 },
  'mimo-v2.5-pro':              { in: 1,   out: 4   },
  'mimo-v2.5':                  { in: 0.5, out: 2   },
  'mimo-v2-flash':              { in: 0.1, out: 0.4 },
  // DeepSeek V4 — cache hits billed at 1/10th of standard input rate.
  'deepseek-v4-flash':          { in: 0.14, out: 0.28, cachedIn: 0.014 },
  'deepseek-v4-pro':            { in: 0.435, out: 0.87, cachedIn: 0.0435 },
};

export function costFor(model: string, input: number, output: number, cachedTokens?: number): number {
  const p = PRICING_USD_PER_MTOK[model] ?? PRICING_USD_PER_MTOK[Object.keys(PRICING_USD_PER_MTOK).find(k => model.includes(k.split('-')[1] ?? '') && k.startsWith(model.split('-')[0] ?? '')) ?? ''] ?? { in: 0, out: 0 };
  const cached = Math.min(cachedTokens ?? 0, input);
  const billable = input - cached;
  const cachedRate = p.cachedIn ?? p.in / 10;
  return (billable / 1_000_000) * p.in + (cached / 1_000_000) * cachedRate + (output / 1_000_000) * p.out;
}

export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult> {
  const { provider, task, context, permissions, display } = opts;

  const profile = getLoopProfile(task, opts.maxTurns);
  const pricingModel = opts.pricingModel ?? provider.model;

  const system = buildSystemPrompt(context, provider.name, task);
  const history: HistoryMessage[] = [
    ...(opts.initialHistory ?? []),
    { role: 'user', content: task },
  ];

  let turns = 0;
  let toolCallCount = 0;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 };

  if (!opts.disableSpawn) {
    registerSpawner(makeDefaultSpawner(context, opts.spawnConfig ?? {}, display));
  }

  display.agentThinking();

  try {
    return await runLoopBody({ opts, provider, system, history, profile, pricingModel, display, permissions, turns, toolCallCount, usage });
  } finally {
    display.stopThinking?.();
    clearSpawner();
  }
}

interface BodyArgs {
  opts: LoopOptions;
  provider: LLMProvider;
  system: string;
  history: HistoryMessage[];
  profile: LoopProfile;
  pricingModel: string;
  display: Display;
  permissions: PermissionSystem;
  turns: number;
  toolCallCount: number;
  usage: TokenUsage;
}

async function runLoopBody(args: BodyArgs): Promise<LoopResult> {
  const { opts, provider, system, history, profile, pricingModel, display, permissions } = args;
  let { turns, toolCallCount, usage } = args;
  const toolCallLog: Array<{ name: string; input: Record<string, unknown> }> = [];
  // Bounded record of state-altering calls; its digest survives compaction so
  // the model never repeats a write/edit/command it already executed.
  const execQueue = new ExecutiveQueue();

  // Context health tracker: observational visibility into token pressure,
  // compaction ladder, and session cost. Never mutates history itself.
  // Use the caller-provided tracker (so /context can read it) or make one.
  const health = opts.healthTracker ?? new ContextHealthTracker(() => system, () => history, provider.model, pricingModel);
  health.updateSystem(system);

  // Stall detection: if the recent turns repeat the exact same tool call(s)
  // (or alternate between the same two), the agent is stuck rather than
  // progressing. Stopping early here saves turns/cost on a run that would
  // otherwise burn out to maxTurns without ever changing course.
  const turnSignatures: string[] = [];
  let stall: StallKind | null = null;

  // Adaptive widening: a run that hits its profile ceiling while still
  // making progress gets ONE upgrade to profile.widenTo instead of dying
  // with a resume hint. Explicit --max-turns never widens.
  let maxTurns = profile.maxTurns;
  let widened = false;

  // Mutable bag for per-loop state (empty-response retry counter, etc.).
  const loopState: Record<string, number> = {};

  // Sticky set of triggered conditional tools — survives history compaction.
  const includedTools = new Set<string>();
  

  while (true) {
    if (turns >= maxTurns) {
      if (profile.widenTo !== undefined && !widened) {
        widened = true;
        maxTurns = profile.widenTo;
        display.warning(
          `Turn budget (${profile.maxTurns}) reached with work in progress — widening once to ${maxTurns}.`,
        );
      } else {
        break;
      }
    }

    // Abort check — user requested stop via :stop / Ctrl+C
    if (opts.abortSignal?.aborted) {
      display.warning('Task cancelled by user — stopping loop.');
      break;
    }

    turns++;
    health.incrementTurn();

    // Compaction check runs pre-call: estimateContextTokens measures the
    // payload about to be sent (see its doc for why not per-turn usage sums).
    {
      const compactionExtras = {
        executiveDigest: execQueue.size > 0 ? execQueue.digest() : undefined,
        affectHint: detectFrustration(history) ?? undefined,
      };
      // The ladder in compactHistory escalates its own trigger per recap
      // generation; once a recap has been recompacted ROLLOVER_AT_GENERATION
      // times, a further in-place pass would just be lossy recompaction —
      // flush it to the dream store instead (one LLM call) and start clean.
      if (getRecapGeneration(history) >= ROLLOVER_AT_GENERATION) {
        const beforeTokens = estimateContextTokens(system, history);
        const { flushed } = await maybeRollover(history, opts.context.root, provider, compactionExtras);
        if (flushed) {
          const afterTokens = estimateContextTokens(system, history);
          const generation = getRecapGeneration(history);
          health.recordCompaction(beforeTokens, afterTokens, generation);
          display.compactionEvent?.({ beforeTokens, afterTokens, generation, threshold: beforeTokens });
          await persist(opts.sessionPath, history);
        }
      } else {
        const estimated = estimateContextTokens(system, history);
        const compacted = compactHistory(history, estimated, provider.model, compactionExtras);
        if (compacted) {
          const afterTokens = estimateContextTokens(system, history);
          const generation = getRecapGeneration(history);
          health.recordCompaction(estimated, afterTokens, generation);
          display.compactionEvent?.({ beforeTokens: estimated, afterTokens, generation, threshold: estimated });
          await persist(opts.sessionPath, history);
        }
      }
    }

    display.contextBar?.(health.snapshot(usage.inputTokens, usage.outputTokens));

    let responseText = '';
    const responseToolCalls: ToolCall[] = [];
    let finalResponse: { stopReason: 'done' | 'tools' | 'limit' } | null = null;

    try {
      const stream = provider.stream(system, history, selectTools(opts.task, history, includedTools));
      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'text':
            display.streamText(chunk.text);
            responseText += chunk.text;
            break;
          case 'tool_start':
            display.toolStart(chunk.name, chunk.id);
            break;
          case 'tool_input':
            break;
          case 'tool_end':
            responseToolCalls.push(chunk.call);
            break;
          case 'done':
            finalResponse = { stopReason: chunk.response.stopReason };
            if (chunk.response.toolCalls.length > 0 && responseToolCalls.length === 0) {
              responseToolCalls.push(...chunk.response.toolCalls);
            }
            const u = (chunk.response as { usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } }).usage;
            if (u) {
              const inT = u.inputTokens ?? 0;
              const outT = u.outputTokens ?? 0;
              const cachedT = u.cachedTokens ?? 0;
              usage.inputTokens += inT;
              usage.outputTokens += outT;
              usage.totalTokens += inT + outT;
              usage.cachedTokens += cachedT;
            }
            break;
        }
      }
    } catch (e) {
      display.error(`Provider error: ${String(e)}`);
      await persist(opts.sessionPath, history);
      return {
        success: false,
        summary: `Provider error on turn ${turns}: ${String(e)}`,
        turns, toolCallCount, usage, history, toolCallLog,
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens),
      };
    }

    if (responseText) display.streamEnd();

    // Guard: an empty response with no tools and stop reason "done"
    // usually means the provider returned a silent error / rate-limit /
    // content filter. Retry up to 3 times before accepting it as "done"
    // so sessions don't silently die with no output.
    const noProgress = !responseText && responseToolCalls.length === 0;
    if (finalResponse?.stopReason === 'done' && noProgress) {
      if (!('_emptyRetries' in loopState)) loopState._emptyRetries = 0;
      loopState._emptyRetries++;
      if (loopState._emptyRetries <= 3) {
        display.warning(
          `Empty response from provider (attempt ${loopState._emptyRetries}/3) — retrying…`,
        );
        display.agentThinking();
        continue;
      }
      // Exhausted retries — provider can't produce output
      history.push({ role: 'assistant', content: '' });
      await persist(opts.sessionPath, history);
      return {
        success: false,
        summary: 'Provider returned empty response after 4 attempts — likely rate-limited or filtered',
        turns, toolCallCount, usage, history, toolCallLog,
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens),
      };
    }

    if (finalResponse?.stopReason === 'done') {
      history.push({ role: 'assistant', content: responseText });
      await persist(opts.sessionPath, history);
      return {
        success: true,
        summary: responseText,
        turns, toolCallCount, usage, history, toolCallLog,
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens),
      };
    }

    if (finalResponse?.stopReason === 'limit') {
      display.warning('Hit token limit — stopping loop');
      break;
    }

    history.push({
      role: 'assistant',
      content: responseText,
      toolCalls: responseToolCalls,
    });

    // Record this turn's tool-call signature before executing, so a
    // stall is detected even if every call in the streak errors out.
    if (responseToolCalls.length > 0) {
      const signature = JSON.stringify(
        responseToolCalls.map((c) => ({ name: c.name, input: c.input })),
      );
      turnSignatures.push(signature);
      stall = detectStall(turnSignatures, profile.stallThreshold);
    }

    const toolResults: ToolResult[] = [];
    // One checkpoint per turn, taken lazily before the first mutating call —
    // a turn's writes form one burst, and the engine dedupes identical trees.
    let checkpointedThisTurn = false;

    for (const call of responseToolCalls) {
      toolCallCount++;
      display.toolCall(call.name, call.input);

      let result: string;
      let isError = false;
      try {
        const perm = permissions.check(call.name, call.input);
        if (!perm.allowed) {
          display.toolBlocked(call.name, perm.reason ?? 'not permitted');
          toolResults.push({ id: call.id, name: call.name, content: `Blocked: ${perm.reason}`, isError: true });
          continue;
        }

        if (perm.needsConfirm) {
          const desc = formatCallForConfirmation(call);
          const approved = await (opts.confirmFn ?? confirm)(`Allow: ${desc}?`);
          if (!approved) {
            display.toolBlocked(call.name, 'denied by user');
            toolResults.push({ id: call.id, name: call.name, content: 'User denied this action.', isError: true });
            continue;
          }
        }

        if (opts.checkpoints !== false && !checkpointedThisTurn && MUTATING_TOOLS.has(call.name)) {
          checkpointedThisTurn = true;
          try {
            const cp = await createCheckpoint(opts.context.root, `turn ${turns}: ${opts.task}`);
            if (cp) await pruneCheckpoints(opts.context.root, DEFAULTS.maxCheckpoints);
          } catch { /* checkpointing must never block the tool call */ }
        }

        if (opts.hooks && opts.hooks.length > 0) {
          const { runHooks } = await import('../plugins/hooks.js');
          const pre = await runHooks('PreToolUse', call.name, call.input, opts.hooks, opts.context.root);
          if (pre.block) {
            const why = pre.messages.join('; ') || 'blocked by plugin hook';
            display.toolBlocked(call.name, why);
            toolResults.push({ id: call.id, name: call.name, content: `Blocked by plugin hook: ${why}`, isError: true });
            continue;
          }
        }

        const startMs = Date.now();
        result = await executeTool(call.name, call.input, opts.context.root);
        const elapsed = Date.now() - startMs;
        display.toolResult(call.name, result, elapsed);
        isError = result.startsWith('Error:') || result.startsWith('Tool error');
        toolCallLog.push({ name: call.name, input: call.input });
        if (!isError) execQueue.push(call.name, call.input, turns);

        if (opts.hooks && opts.hooks.length > 0) {
          const { runHooks } = await import('../plugins/hooks.js');
          await runHooks('PostToolUse', call.name, call.input, opts.hooks, opts.context.root, result);
        }
      } catch (e) {
        result = `Tool error (${call.name}): ${String(e)}`;
        isError = true;
        display.error(result);
      }
      toolResults.push({ id: call.id, name: call.name, content: result, isError });
    }

    health.incrementToolCalls(responseToolCalls.length);

    history.push({ role: 'tool_result', results: toolResults });

    if (stall) {
      display.warning(stall === 'repeat'
        ? `Repeated identical tool call ${profile.stallThreshold}x in a row — stopping loop (stall detected)`
        : `Alternating between the same two tool calls ${profile.stallThreshold}x — stopping loop (cycle stall detected)`);
      break;
    }

    display.agentThinking();
  }

  await persist(opts.sessionPath, history);
  const sessionId = opts.sessionPath ? path.basename(opts.sessionPath, '.json') : undefined;
  const resumeHint = sessionId ? ` Type /continue to resume session ${sessionId}` : '';
  const reason = stall === 'repeat' ? 'stalled (repeated identical tool calls)'
    : stall === 'cycle' ? 'stalled (cycling between the same two tool calls)'
    : `ended after ${turns} turns${widened ? `, after widening once from ${profile.maxTurns}` : ''}`;
  return {
    success: false,
    summary: `Loop ${reason}.${resumeHint}`,
    turns, toolCallCount, usage, history, toolCallLog,
    costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens, usage.cachedTokens),
  };
}

export async function runAgentLoopVerified(
  opts: LoopOptions,
  config: VerificationConfig,
  projectRoot: string,
): Promise<{ loopResult: LoopResult; verifyResult: import('../verify/types.js').VerificationResult; totalAttempts: number }> {
  const { runWithVerification } = await import('../verify/index.js');
  return runWithVerification({ loopOpts: opts, config, projectRoot, display: opts.display });
}

async function persist(path: string | undefined, history: HistoryMessage[]): Promise<void> {
  if (!path) return;
  try { await sessionStore.save(path, history); }
  catch { /* persistence is best-effort */ }
}

function formatCallForConfirmation(call: ToolCall): string {
  if (call.name === 'run_shell') return `$ ${call.input.command}`;
  if (call.name === 'write_file') return `overwrite ${call.input.path}`;
  if (call.name === 'mcp' && call.input.action === 'connect') {
    const args = Array.isArray(call.input.args_list) ? (call.input.args_list as string[]).join(' ') : '';
    return `spawn MCP server '${call.input.server}': ${call.input.command} ${args}`.trim();
  }
  return `${call.name}(${JSON.stringify(call.input).slice(0, 80)})`;
}
