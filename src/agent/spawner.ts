import * as path from 'path';
import type { LLMProvider, HistoryMessage, StreamChunk, LLMResponse } from '../providers/types.js';
import { createProvider } from '../providers/factory.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { ProjectContext } from './context.js';
import type { Display } from '../cli/display.js';

export interface SpawnOptions {
  task: string;
  model?: string;
  readonly?: boolean;
  cwd?: string;
}

export interface Spawner {
  spawn(opts: SpawnOptions): Promise<string>;
}

interface ActiveSpawner {
  spawn: (opts: SpawnOptions) => Promise<string>;
}

let active: ActiveSpawner | null = null;

/**
 * Wire up the spawn_task tool to a real implementation. Called by the
 * agent loop before running. Stays module-local so we don't need to thread
 * it through every layer.
 */
export function registerSpawner(spawner: ActiveSpawner): void {
  active = spawner;
}

export function clearSpawner(): void {
  active = null;
}

/**
 * Which model a spawned sub-agent runs on.
 *
 * The caller's explicit pick wins (the model that asked to delegate knows its
 * sub-problem), then AURA_SUBAGENT_MODEL (a user pins their provider's cheap
 * rung — on OpenRouter's z-ai that is glm-5.3-flash today), then the session's
 * own model. No hardcoded fallback: a name like `mimo-v2-flash` is a private
 * arrangement with one provider — other users have no such model, and their
 * spawn_task calls would 404.
 */
export function resolveSubagentModel(
  explicit: string | undefined,
  env: { AURA_SUBAGENT_MODEL?: string },
  sessionModel: string | undefined,
): string | undefined {
  const pin = explicit?.trim() || env.AURA_SUBAGENT_MODEL?.trim() || '';
  return pin || sessionModel?.trim() || undefined;
}

/**
 * Default spawner — spins up a fresh provider, runs the agent loop, returns summary.
 */
export function makeDefaultSpawner(
  ctx: ProjectContext,
  baseConfig: { apiKey?: string; baseUrl?: string; model?: string; sessionId?: string },
  display: Display,
): Spawner {
  return {
    async spawn(opts: SpawnOptions): Promise<string> {
      const model = resolveSubagentModel(opts.model, process.env, baseConfig.model);
      if (!model) {
        return 'Error: no sub-agent model — the session has none and AURA_SUBAGENT_MODEL is unset.';
      }
      const provider: LLMProvider = createProvider({
        model,
        apiKey: baseConfig.apiKey,
        baseUrl: baseConfig.baseUrl,
      });
      display.subagentSpawned?.({ model, task: opts.task, readonly: opts.readonly === true });
      // Lazy import to avoid a cycle (loop imports us; we import loop)
      const { runAgentLoop } = await import('./loop.js');
      const { PermissionSystem } = await import('../safety/permissions.js');
      const level: 'read-only' | 'auto' = opts.readonly ? 'read-only' : 'auto';
      const result = await runAgentLoop({
        provider,
        task: opts.task,
        context: ctx,
        permissions: new PermissionSystem(level),
        display,
        // No explicit maxTurns: let loop-profile size the sub-agent's
        // budget from its task shape, same as the top-level loop.
      });
      const cost = result.costUsd.toFixed(4);
      return `[subagent ${model}]\n${result.summary}\n[cost: $${cost} · ${result.turns} turns · ${result.toolCallCount} tools]`;
    },
  };
}

export async function executeSpawnTask(input: Record<string, unknown>): Promise<string> {
  if (!active) return 'Error: spawn_task is not available in this context';
  const task = String(input.task ?? '').trim();
  if (!task) return 'Error: spawn_task requires a non-empty "task"';
  const opts: SpawnOptions = {
    task,
    model: typeof input.model === 'string' ? input.model : undefined,
    readonly: input.readonly === true,
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
  };
  return active.spawn(opts);
}

export const SPAWN_TASK_DEFINITION = {
  name: 'spawn_task',
  description: 'Delegate a sub-task to a fresh agent. Useful for parallelising work, using a different model for a sub-problem, or isolating side-effects. Returns the sub-agent\'s final summary.',
  parameters: {
    type: 'object' as const,
    properties: {
      task:    { type: 'string',  description: 'The task description for the sub-agent' },
      model:   { type: 'string',  description: 'Model id to use (default: this session\'s model, or AURA_SUBAGENT_MODEL when set)' },
      readonly:{ type: 'boolean', description: 'Run sub-agent in read-only mode (no file writes or shell). Default: false (auto mode)' },
      cwd:     { type: 'string',  description: 'Optional working directory for the sub-agent' },
    },
    required: ['task'],
  },
};
