/**
 * The swarm orchestrator — where a board task carrying an agent roster stops
 * being a label and becomes concurrent executions.
 *
 * A task with `swarm.agents` runs one agent loop per roster entry. The
 * `parallel` strategy launches them all at once: they share an objective and
 * a project context, and their outcomes are merged onto the tile. Pipeline
 * and hierarchical strategies are declared by the UI but not yet orchestrated
 * — a task that asks for one still runs its agents in parallel rather than
 * doing nothing, because agents that run are worth more than a strategy that
 * is waited for.
 *
 * Concurrency is the point here, and it is also the hazard: several
 * write-capable agents editing one working tree can collide. That is an
 * inherent property of a parallel swarm rather than a bug in it — the
 * operator chose the roster. The single-writer queue that guards ordinary
 * board runs deliberately does not extend into the swarm.
 */

import type { BoardTask, SwarmAgent } from '../board/types.js';
import { taskPrompt } from '../board/store.js';

import { runAgentLoop } from './loop.js';
import { createProvider } from '../providers/factory.js';
import { PermissionSystem } from '../safety/permissions.js';
import { SessionBudget } from './session-budget.js';
import type { ProjectContext } from './context.js';
import type { Display } from '../cli/display.js';

export type SwarmPermission = 'read-only' | 'normal' | 'auto';

export interface SwarmAgentOutcome {
  agent: SwarmAgent;
  success: boolean;
  summary: string;
  files: string[];
}

/** Progress and completion are pushed to the caller as the swarm runs. */
export type SwarmAgentUpdateFn = (agentId: string, patch: Partial<SwarmAgent>) => void;

export interface SwarmRunOptions {
  task: BoardTask;
  context: ProjectContext;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  permission: SwarmPermission;
  allowedTools?: string[] | null;
  onAgentUpdate: SwarmAgentUpdateFn;
  /** Polled while agents run; true aborts everything (the tile left execution). */
  shouldStop?: () => boolean;
}

/**
 * A role-scoped prompt. Every agent sees the same objective; what differs is
 * who it is supposed to be, which is what makes concurrent runs a swarm
 * rather than the same call made twice.
 */
export function agentPrompt(agent: SwarmAgent, task: BoardTask): string {
  const base = taskPrompt(task);
  const role = agent.role?.trim();
  if (!role) return base;
  return [
    `You are ${agent.name}, one member of a parallel agent swarm working a shared objective.`,
    `Your role in the swarm: ${role}. Work within that role and deliver your part of the outcome.`,
    '',
    base,
  ].join('\n');
}

/**
 * Fold per-agent outcomes into one tile result. Partial success counts as
 * success — a swarm where 3 of 4 agents delivered has 3 deliverables — but
 * the summary says plainly who did not, because a merged report that hides a
 * failed agent trains people to stop reading it.
 */
export function mergeSwarmOutcomes(outcomes: SwarmAgentOutcome[]): {
  summary: string;
  success: boolean;
  files: string[];
} {
  const done = outcomes.filter((o) => o.success);
  const failed = outcomes.filter((o) => !o.success);
  const files = [...new Set(outcomes.flatMap((o) => o.files))].filter(Boolean);

  const header = `🐝 Swarm finished: ${done.length}/${outcomes.length} agents completed.`;
  const sections = outcomes.map((o) => {
    const icon = o.agent.icon || '•';
    const mark = o.success ? '✓' : '✗';
    const modelTag = o.agent.model ? ` \`${o.agent.model}\`` : '';
    const body = o.summary?.trim() || (o.success ? '(no summary)' : '(agent failed)');
    return `### ${icon} ${o.agent.name}${modelTag} ${mark}\n${body}`;
  });

  return {
    summary: [header, '', ...sections].join('\n\n'),
    success: done.length > 0,
    files,
  };
}

/** A display that goes nowhere — swarm agents report through the board, not the chat stream. */
function silentDisplay(): Display {
  const noop = () => {};
  return {
    agentThinking: noop, streamText: noop, streamEnd: noop,
    toolStart: noop, toolCall: noop, toolResult: noop, toolBlocked: noop,
    warning: noop, success: noop, error: noop, header: noop, summary: noop,
    showPlan: noop, stepStarted: noop, stepCompleted: noop,
  };
}

const SUMMARY_SLICE = 2000;

/**
 * Run every agent on the task concurrently and report per-agent progress
 * through `onAgentUpdate` as it happens. Resolves when all agents settle.
 */
export async function runSwarm(opts: SwarmRunOptions): Promise<SwarmAgentOutcome[]> {
  const { task, context, model, apiKey, baseUrl, permission, allowedTools, onAgentUpdate } = opts;

  const agents = task.swarm?.agents ?? [];
  const controllers = new Map<string, AbortController>();

  // The tile being pulled back out of execution is the stop signal — the
  // operator's STOP button already rewrites the column, so the swarm watches
  // the board instead of needing a protocol method of its own.
  const stopPoll = opts.shouldStop
    ? setInterval(() => {
        if (opts.shouldStop?.()) {
          for (const c of controllers.values()) c.abort();
        }
      }, 2000)
    : null;
  if (stopPoll) stopPoll.unref?.();

  const runs = agents.map(async (agent): Promise<SwarmAgentOutcome> => {
    const abort = new AbortController();
    controllers.set(agent.id, abort);
    onAgentUpdate(agent.id, { status: 'running' });

    try {
      // The agent's own model wins; the task's model is the fallback. Each
      // agent resolves its own key through the same factory routing, so a
      // mixed swarm talks to a mixed set of providers. The task-level key is
      // only handed to agents on the task's own model — an OpenRouter key
      // must never ride along to an agent that is talking to Zhipu.
      const agentModel = agent.model?.trim() || model;
      const inheritedKey = agentModel === model ? apiKey : undefined;
      const provider = createProvider({ model: agentModel, ...(inheritedKey ? { apiKey: inheritedKey } : {}), ...(baseUrl ? { baseUrl } : {}) });
      const result = await runAgentLoop({
        provider,
        task: agentPrompt(agent, task),
        context,
        permissions: new PermissionSystem(permission),
        display: silentDisplay(),
        ...(allowedTools ? { allowedTools } : {}),
        budget: new SessionBudget({}),
        initialHistory: [],
        abortSignal: abort.signal,
      });
      // Modified files come from the tool-call log, the same derivation the
      // single-session path uses — the loop does not report them directly.
      const files = Array.from(new Set(
        result.toolCallLog
          .filter((t) => (t.name === 'write_file' || t.name === 'edit_file') && typeof t.input?.path === 'string')
          .map((t) => String(t.input.path)),
      ));
      return {
        agent,
        success: result.success,
        summary: result.summary.slice(0, SUMMARY_SLICE),
        files,
      };
    } catch (e) {
      return {
        agent,
        success: false,
        summary: abort.signal.aborted
          ? 'Stopped by operator.'
          : (e instanceof Error ? e.message : String(e)).slice(0, SUMMARY_SLICE),
        files: [],
      };
    } finally {
      controllers.delete(agent.id);
    }
  });

  const settled = await Promise.allSettled(runs);
  if (stopPoll) clearInterval(stopPoll);

  const outcomes: SwarmAgentOutcome[] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      agent: agents[i],
      success: false,
      summary: r.reason instanceof Error ? r.reason.message : String(r.reason),
      files: [],
    };
  });

  // Push final per-agent state so the tile carries who did what even if the
  // merged write below is the only other survivor.
  for (const o of outcomes) {
    onAgentUpdate(o.agent.id, {
      status: o.success ? 'done' : 'failed',
      summary: o.summary.slice(0, 400),
    });
  }

  return outcomes;
}
