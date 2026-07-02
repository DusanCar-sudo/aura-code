/**
 * Mixture of Agents — Phase 2: parallel domain sub-agents.
 *
 * For exploratory-shaped tasks (per loop-profile.ts — that's where ambiguity
 * actually benefits from multiple angles), fan out 2-3 read-only sub-agents
 * in parallel, each framed with a different domain lens, then synthesize
 * their reports into one answer with a real model call.
 *
 * Design constraints (see docs/MIXTURE_OF_AGENTS.md):
 * - Read-only only — parallel sub-agents never edit files.
 * - Gated by task shape AND an explicit opt-in (--moa). The N-call cost is
 *   real; it stays off the default path until benchmarks justify it.
 * - Synthesis is an actual provider call — reconciling N expert opinions
 *   is judgment, not pattern matching.
 */

import type { LLMProvider } from '../providers/types.js';
import type { ProjectContext } from './context.js';
import type { Display } from '../cli/display.js';
import type { LoopResult, TokenUsage } from './loop.js';
import { runAgentLoop, costFor } from './loop.js';
import { PermissionSystem } from '../safety/permissions.js';
import { classifyDomains } from './domain-expertise.js';

export interface MixtureOptions {
  provider: LLMProvider;
  task: string;
  context: ProjectContext;
  display: Display;
  /** Optional model pricing id, as in LoopOptions. */
  pricingModel?: string;
}

/**
 * Sub-agent streams would interleave garbage if they all wrote to the real
 * display. Mute everything except warnings/errors, which are rare and
 * worth surfacing (prefixed so the user can tell whose they are).
 */
function mutedDisplay(base: Display, label: string): Display {
  return {
    agentThinking: () => {},
    streamText: () => {},
    streamEnd: () => {},
    toolStart: () => {},
    toolCall: () => {},
    toolResult: () => {},
    toolBlocked: () => {},
    warning: (msg) => base.warning(`[${label}] ${msg}`),
    success: () => {},
    error: (msg) => base.error(`[${label}] ${msg}`),
    header: () => {},
    summary: () => {},
    showPlan: () => {},
    stepStarted: () => {},
    stepCompleted: () => {},
  };
}

function perspectiveTask(lens: string, task: string): string {
  return [
    `You are investigating as a ${lens} specialist. You are in read-only mode — do not modify any files or run state-changing commands.`,
    '',
    `Task: ${task}`,
    '',
    `Investigate the codebase strictly from the ${lens} angle. Your final message must be a compact report:`,
    '1. FINDINGS — concrete observations with file paths / line references.',
    `2. ANSWER — the most likely explanation or answer from the ${lens} perspective.`,
    '3. CONFIDENCE — low / medium / high, with one sentence why.',
  ].join('\n');
}

const SYNTHESIS_SYSTEM = [
  'You are synthesizing reports from parallel specialist investigators who each examined the same task from a different angle.',
  'Reconcile them into ONE answer: where they agree, state it plainly; where they conflict, weigh confidence and evidence and say which reading you trust and why.',
  'Do not enumerate the reports back — produce the merged answer a user should act on, citing file paths the specialists found.',
].join(' ');

/**
 * Run the mixture: N parallel read-only sub-agents + one synthesis call.
 * Returns a LoopResult so callers can treat it exactly like a single-agent
 * run (summary display, cost footer, exit codes).
 */
export async function runMixtureOfAgents(opts: MixtureOptions): Promise<LoopResult> {
  const { provider, task, context, display } = opts;

  const domains = classifyDomains(task);
  const lenses: string[] = domains.length > 0
    ? [...domains, 'generalist']
    : ['architecture', 'generalist'];

  display.header('Mixture of Agents', `${lenses.length} parallel read-only perspectives: ${lenses.join(', ')}`);

  const runs = await Promise.all(lenses.map((lens) =>
    runAgentLoop({
      provider,
      task: perspectiveTask(lens, task),
      context,
      permissions: new PermissionSystem('read-only'),
      display: mutedDisplay(display, lens),
      // Sub-agents must not fan out further — one level of parallelism.
      disableSpawn: true,
      pricingModel: opts.pricingModel,
    }).catch((e): LoopResult => ({
      success: false,
      summary: `Perspective failed: ${String(e)}`,
      turns: 0, toolCallCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0, history: [], toolCallLog: [],
    })),
  ));

  runs.forEach((r, i) => {
    display.success(`[${lenses[i]}] ${r.success ? 'reported' : 'failed'} — ${r.turns} turns, $${r.costUsd.toFixed(4)}`);
  });

  const usage: TokenUsage = runs.reduce((acc, r) => ({
    inputTokens: acc.inputTokens + r.usage.inputTokens,
    outputTokens: acc.outputTokens + r.usage.outputTokens,
    totalTokens: acc.totalTokens + r.usage.totalTokens,
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const turns = runs.reduce((n, r) => n + r.turns, 0);
  const toolCallCount = runs.reduce((n, r) => n + r.toolCallCount, 0);
  let costUsd = runs.reduce((c, r) => c + r.costUsd, 0);

  const succeeded = runs.filter((r) => r.success);
  if (succeeded.length === 0) {
    return {
      success: false,
      summary: `All ${lenses.length} perspectives failed:\n${runs.map((r, i) => `[${lenses[i]}] ${r.summary}`).join('\n')}`,
      turns, toolCallCount, usage, costUsd, history: [], toolCallLog: [],
    };
  }

  const reports = runs
    .map((r, i) => `## Report from the ${lenses[i]} specialist${r.success ? '' : ' (FAILED — weigh accordingly)'}\n\n${r.summary}`)
    .join('\n\n');

  display.agentThinking();
  const synthesis = await provider.complete(SYNTHESIS_SYSTEM, [
    { role: 'user', content: `Original task: ${task}\n\n${reports}` },
  ], []);

  const su = (synthesis as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
  if (su) {
    usage.inputTokens += su.inputTokens ?? 0;
    usage.outputTokens += su.outputTokens ?? 0;
    usage.totalTokens += (su.inputTokens ?? 0) + (su.outputTokens ?? 0);
    costUsd += costFor(opts.pricingModel ?? provider.model, su.inputTokens ?? 0, su.outputTokens ?? 0);
  }

  return {
    success: true,
    summary: synthesis.text || '(Synthesis produced no output)',
    turns: turns + 1,
    toolCallCount,
    usage,
    costUsd,
    history: [{ role: 'user', content: task }, { role: 'assistant', content: synthesis.text }],
    toolCallLog: runs.flatMap((r) => r.toolCallLog),
  };
}
