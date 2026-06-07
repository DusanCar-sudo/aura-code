import type { VerificationResult, VerificationConfig } from './types.js';
import { runAllChecks, collectProjectFiles, collectFailingTests, type CheckContext } from './checks.js';
import type { LoopOptions, LoopResult } from '../agent/loop.js';
import type { Display } from '../cli/display.js';

export type { VerificationResult, VerificationConfig, Check, ToolCallLogEntry } from './types.js';
export type { CheckContext } from './checks.js';
export { collectProjectFiles, collectFailingTests } from './checks.js';

export function buildSuggestion(checks: { passed: boolean; detail: string }[]): string {
  const failed = checks.filter(c => !c.passed);
  if (failed.length === 0) return '';
  const reasons = failed.map(c => c.detail).join('; ');
  return `Previous attempt failed: ${reasons}.`;
}

export function shouldRetry(result: VerificationResult, config: VerificationConfig): boolean {
  return !result.passed && result.attempts < config.maxRetries;
}

export async function verifyTask(
  ctx: CheckContext,
  config: VerificationConfig,
  attempts: number = 1,
): Promise<VerificationResult> {
  const checks = runAllChecks(ctx);
  const passed = checks.every(c => c.passed);
  const suggestion = passed ? '' : buildSuggestion(checks);
  return { passed, checks, attempts, suggestion };
}

export function runVerificationSync(
  ctx: CheckContext,
  config: VerificationConfig,
  attempts: number = 1,
): VerificationResult {
  const checks = runAllChecks(ctx);
  const passed = checks.every(c => c.passed);
  const suggestion = passed ? '' : buildSuggestion(checks);
  return { passed, checks, attempts, suggestion };
}

export interface RunWithVerificationResult {
  loopResult: LoopResult;
  verifyResult: VerificationResult;
  totalAttempts: number;
}

export interface WithVerificationOptions {
  loopOpts: Omit<LoopOptions, 'verify' | 'verifyConfig'>;
  config: VerificationConfig;
  projectRoot: string;
  display: Display;
}

/**
 * External wrapper around runAgentLoop.
 *
 * Runs the agent loop, then verifies output. If verification fails and retries
 * remain, prepends failure context and reruns. runAgentLoop itself is NOT
 * modified — all retry logic lives here.
 */
export async function runWithVerification(
  opts: WithVerificationOptions,
): Promise<RunWithVerificationResult> {
  const { runAgentLoop } = await import('../agent/loop.js');
  const { loopOpts, config, projectRoot, display } = opts;
  const originalTask = loopOpts.task;
  let currentTask = originalTask;
  let loopResult!: LoopResult;
  let verifyResult!: VerificationResult;

  // Capture pre-existing test failures so we don't blame the task for them
  let baselineFailures: Set<string> | undefined;
  if (config.testCommand) {
    baselineFailures = collectFailingTests(config.testCommand, projectRoot);
    if (baselineFailures.size > 0) {
      display.warning(`Baseline: ${baselineFailures.size} pre-existing test failure(s) — will be ignored`);
    }
  }

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    display.header(`Attempt ${attempt}/${config.maxRetries}`, originalTask);

    const taskStartedAt = Date.now();
    const filesBefore = collectProjectFiles(projectRoot);

    loopResult = await runAgentLoop({
      ...loopOpts,
      task: currentTask,
      verify: false,
    });

    const ctx: CheckContext = {
      projectRoot,
      taskStartedAt,
      task: originalTask,
      toolCalls: loopResult.toolCallLog,
      filesBefore,
      testCommand: config.testCommand,
      baselineFailures,
    };

    verifyResult = await verifyTask(ctx, config, attempt);

    if (verifyResult.passed) {
      if (attempt > 1) {
        display.success(`Verification passed on attempt ${attempt}`);
      }
      break;
    }

    display.warning(`Verification failed (attempt ${attempt}/${config.maxRetries})`);
    for (const c of verifyResult.checks) {
      if (!c.passed) {
        display.warning(`  ${c.name}: ${c.detail}`);
      }
    }

    if (attempt < config.maxRetries) {
      currentTask = `${buildSuggestion(verifyResult.checks)} Retry: ${originalTask}`;
    }
  }

  return { loopResult, verifyResult, totalAttempts: verifyResult.attempts };
}
