import * as path from 'path';
import type { LLMProvider, HistoryMessage, ToolCall, ToolResult } from '../providers/types.js';
import { TOOL_DEFINITIONS, executeTool } from '../tools/index.js';
import { PermissionSystem } from '../safety/permissions.js';
import { confirm } from '../safety/permissions.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { ProjectContext } from './context.js';
import type { Display } from '../cli/display.js';
import { DEFAULTS } from '../config/defaults.js';
import { sessionStore } from './session-store.js';
import { registerSpawner, clearSpawner, makeDefaultSpawner } from './spawner.js';
import type { VerificationConfig } from '../verify/types.js';
import { compactHistory } from './compactor.js';

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
  /**
   * Custom confirmation function for destructive operations.
   * Defaults to terminal-based confirm() from permissions.
   * Telegram bot overrides this to send approval requests via Telegram messages.
   */
  confirmFn?: (message: string) => Promise<boolean>;
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
}

const PRICING_USD_PER_MTOK: Record<string, { in: number; out: number }> = {
  'claude-opus-4-5-20251001':   { in: 15,  out: 75  },
  'claude-sonnet-4-5-20251001': { in: 3,   out: 15  },
  'claude-haiku-4-5-20251001':  { in: 0.8, out: 4   },
  'gpt-4o':                     { in: 2.5, out: 10  },
  'gpt-4o-mini':                { in: 0.15,out: 0.6 },
  'gemini-2.5-pro':             { in: 1.25,out: 10  },
  'gemini-2.5-flash':           { in: 0.075,out: 0.3},
  'grok-beta':                  { in: 5,   out: 15  },
  'mimo-v2.5-pro':              { in: 1,   out: 4   },
  'mimo-v2.5':                  { in: 0.5, out: 2   },
  'mimo-v2-flash':              { in: 0.1, out: 0.4 },
};

function costFor(model: string, input: number, output: number): number {
  const p = PRICING_USD_PER_MTOK[model] ?? PRICING_USD_PER_MTOK[Object.keys(PRICING_USD_PER_MTOK).find(k => model.includes(k.split('-')[1] ?? '') && k.startsWith(model.split('-')[0] ?? '')) ?? ''] ?? { in: 0, out: 0 };
  return (input / 1_000_000) * p.in + (output / 1_000_000) * p.out;
}

export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult> {
  const { provider, task, context, permissions, display } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULTS.maxTurns;
  const pricingModel = opts.pricingModel ?? provider.model;

  const system = buildSystemPrompt(context, provider.name);
  const history: HistoryMessage[] = [
    ...(opts.initialHistory ?? []),
    { role: 'user', content: task },
  ];

  let turns = 0;
  let toolCallCount = 0;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  if (!opts.disableSpawn) {
    registerSpawner(makeDefaultSpawner(context, opts.spawnConfig ?? {}, display));
  }

  display.agentThinking();

  try {
    return await runLoopBody({ opts, provider, system, history, maxTurns, pricingModel, display, permissions, turns, toolCallCount, usage });
  } finally {
    clearSpawner();
  }
}

interface BodyArgs {
  opts: LoopOptions;
  provider: LLMProvider;
  system: string;
  history: HistoryMessage[];
  maxTurns: number;
  pricingModel: string;
  display: Display;
  permissions: PermissionSystem;
  turns: number;
  toolCallCount: number;
  usage: TokenUsage;
}

async function runLoopBody(args: BodyArgs): Promise<LoopResult> {
  const { opts, provider, system, history, maxTurns, pricingModel, display, permissions } = args;
  let { turns, toolCallCount, usage } = args;
  const toolCallLog: Array<{ name: string; input: Record<string, unknown> }> = [];

  while (turns < maxTurns) {
    turns++;

    compactHistory(history, usage.totalTokens, provider.model);

    let responseText = '';
    const responseToolCalls: ToolCall[] = [];
    let finalResponse: { stopReason: 'done' | 'tools' | 'limit' } | null = null;

    try {
      const stream = provider.stream(system, history, TOOL_DEFINITIONS);
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
            const u = (chunk.response as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
            if (u) {
              const inT = u.inputTokens ?? 0;
              const outT = u.outputTokens ?? 0;
              usage.inputTokens += inT;
              usage.outputTokens += outT;
              usage.totalTokens += inT + outT;
            }
            break;
        }
      }
    } catch (e) {
      display.error(`Provider error: ${String(e)}`);
      // If we failed on the first turn without making any tool calls, the assistant
      // never responded. Pop the user's task so we don't poison the chat history
      // with consecutive user messages on the next attempt.
      if (turns === 1 && toolCallCount === 0) {
        history.pop();
      }
      await persist(opts.sessionPath, history);
      return {
        success: false,
        summary: `Provider error on turn ${turns}: ${String(e)}`,
        turns, toolCallCount, usage, history, toolCallLog,
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens),
      };
    }

    if (responseText) display.streamEnd();

    const noProgress = !responseText && responseToolCalls.length === 0;
    if (noProgress || finalResponse?.stopReason === 'done') {
      history.push({ role: 'assistant', content: responseText });
      await persist(opts.sessionPath, history);
      return {
        success: true,
        summary: responseText || '(Task completed with no output)',
        turns, toolCallCount, usage, history, toolCallLog,
        costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens),
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

    const toolResults: ToolResult[] = [];

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
          const doConfirm = opts.confirmFn ?? confirm;
          const approved = await doConfirm(`Allow: ${desc}?`);
          if (!approved) {
            display.toolBlocked(call.name, 'denied by user');
            toolResults.push({ id: call.id, name: call.name, content: 'User denied this action.', isError: true });
            continue;
          }
        }

        const startMs = Date.now();
        result = await executeTool(call.name, call.input, opts.context.root);
        const elapsed = Date.now() - startMs;
        display.toolResult(call.name, result, elapsed);
        isError = result.startsWith('Error:') || result.startsWith('Tool error');
        toolCallLog.push({ name: call.name, input: call.input });
      } catch (e) {
        result = `Tool error (${call.name}): ${String(e)}`;
        isError = true;
        display.error(result);
      }
      toolResults.push({ id: call.id, name: call.name, content: result, isError });
    }

    history.push({ role: 'tool_result', results: toolResults });
    display.agentThinking();
  }

  await persist(opts.sessionPath, history);
  const sessionId = opts.sessionPath ? path.basename(opts.sessionPath, '.json') : undefined;
  const resumeHint = sessionId ? ` Type /continue to resume session ${sessionId}` : '';
  return {
    success: false,
    summary: `Loop ended after ${turns} turns.${resumeHint}`,
    turns, toolCallCount, usage, history, toolCallLog,
    costUsd: costFor(pricingModel, usage.inputTokens, usage.outputTokens),
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
  return `${call.name}(${JSON.stringify(call.input).slice(0, 80)})`;
}
