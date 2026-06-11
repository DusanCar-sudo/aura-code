import * as path from 'path';
import type { LLMProvider, HistoryMessage, StreamChunk, LLMResponse } from '../providers/types.js';
import { createProvider } from '../providers/factory.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { ProjectContext } from './context.js';
import { DEFAULTS } from '../config/defaults.js';
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
 * Default spawner — spins up a fresh provider, runs the agent loop, returns summary.
 */
export function makeDefaultSpawner(
  ctx: ProjectContext,
  baseConfig: { apiKey?: string; baseUrl?: string; sessionId?: string },
  display: Display,
): Spawner {
  return {
    async spawn(opts: SpawnOptions): Promise<string> {
      const model = opts.model ?? 'mimo-v2-flash';
      const provider: LLMProvider = createProvider({
        model,
        apiKey: baseConfig.apiKey,
        baseUrl: opts.cwd ? baseConfig.baseUrl : baseConfig.baseUrl,
      });
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
        maxTurns: DEFAULTS.maxTurns,
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
      model:   { type: 'string',  description: 'Model id to use (default: mimo-v2-flash — fast & cheap)' },
      readonly:{ type: 'boolean', description: 'Run sub-agent in read-only mode (no file writes or shell). Default: false (auto mode)' },
      cwd:     { type: 'string',  description: 'Optional working directory for the sub-agent' },
    },
    required: ['task'],
  },
};
