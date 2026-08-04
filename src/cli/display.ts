import chalk from 'chalk';
import type { ExecutionPlan, PlanStep } from '../orchestration/types.js';
import { formatContextBar as formatContextBarFromHealth, formatContextDashboard } from './context-health.js';
import { TEXT_HEX, TEXT_DIM_HEX, FAINT_HEX } from './diamond.js';

// The Display interface — used by the loop, easy to swap (web UI later)
export interface Display {
  agentThinking(): void;
  streamText(text: string): void;
  streamEnd(): void;
  toolStart(name: string, id: string): void;
  toolCall(name: string, input: Record<string, unknown>): void;
  toolResult(name: string, result: string, elapsedMs: number): void;
  toolBlocked(name: string, reason: string): void;
  warning(msg: string): void;
  success(msg: string): void;
  error(msg: string): void;
  header(title: string, subtitle?: string): void;
  summary(text: string, turns: number, toolCount: number): void;
  /** Renders the full execution plan before running it. */
  showPlan(plan: ExecutionPlan): void;
  /** Emitted when a specialist step begins executing. */
  stepStarted(step: PlanStep): void;
  /** Emitted when a specialist step finishes (success or failure). */
  stepCompleted(step: PlanStep, result: string): void;
  /** Provider is backing off before a retry. */
  retry?(info: { provider: string; attempt: number; delayMs: number; reason: string }): void;
  /** Switched from one provider to a fallback. */
  failover?(info: { from: string; to: string; reason: string }): void;
  /** Circuit breaker for a provider opened or closed. */
  circuit?(info: { provider: string; state: 'closed' | 'open' | 'half-open' }): void;
  /** One-line context health bar — shown before each LLM call. */
  contextBar?(health: import('./context-health.js').ContextHealth): void;
  /** Full context dashboard — shown on /context command. */
  contextDashboard?(health: import('./context-health.js').ContextHealth): void;
  /** Compaction event — replaces the current generic warning. */
  compactionEvent?(info: { beforeTokens: number; afterTokens: number; generation: number; threshold: number }): void;
  /** Stop the thinking spinner. Called when the loop exits. */
  stopThinking?(): void;
}

export function createTerminalDisplay(): Display {
  let inStream = false;
  let currentTool = '';

  return {
    agentThinking() {
      process.stdout.write(chalk.hex(FAINT_HEX)('  ◆ ') + chalk.hex(TEXT_DIM_HEX)('thinking…') + '\r');
    },

    stopThinking() {
      // Terminal display doesn't use a spinner — nothing to clear.
    },

    streamText(text: string) {
      if (!inStream) {
        process.stdout.write('\n' + chalk.hex(TEXT_HEX)(''));
        inStream = true;
      }
      process.stdout.write(chalk.hex(TEXT_HEX)(text));
    },

    streamEnd() {
      if (inStream) {
        process.stdout.write('\n');
        inStream = false;
      }
    },

    toolStart(name: string, _id: string) {
      currentTool = name;
    },

    toolCall(name: string, input: Record<string, unknown>, model?: string, provider?: string) {
      if (model) {
          // Update the displayed model
          console.log(`Model: ${model}`);
      }
      if (provider) {
          // Update the displayed provider
          console.log(`Provider: ${provider}`);
      }
      process.stdout.write('\n');
      const icon = toolIcon(name);
      // Reset thinking icon after processing
      process.stdout.write('\n');
      const label = chalk.hex('#cc785c').bold(`${icon} ${name}`);
      const detail = formatInput(name, input);
      console.log(`  ${label}  ${chalk.hex(TEXT_DIM_HEX)(detail)}`);
    },

    toolResult(name: string, result: string, elapsedMs: number) {
      const lines = result.split('\n');
      const preview = lines.length > 8
        ? lines.slice(0, 8).join('\n') + chalk.hex(FAINT_HEX)(`\n  ... (${lines.length - 8} more lines)`)
        : result;

      const elapsed = chalk.hex(FAINT_HEX)(`${elapsedMs}ms`);
      const isError = result.startsWith('Error:') || result.startsWith('Tool error');

      if (isError) {
        console.log('  ' + chalk.hex('#b15439')('✗ ') + chalk.hex(TEXT_DIM_HEX)(preview.replace(/\n/g, '\n    ')));
      } else {
        // Show a compact preview
        const firstLine = lines[0] ?? '';
        if (lines.length <= 3) {
          console.log('  ' + chalk.hex('#5a9e6e')('✓ ') + chalk.hex(TEXT_DIM_HEX)(result));
        } else {
          console.log('  ' + chalk.hex('#5a9e6e')('✓ ') + chalk.hex(TEXT_DIM_HEX)(`${firstLine}`) + chalk.hex(FAINT_HEX)(` (+${lines.length - 1} lines) ${elapsed}`));
        }
      }
    },

    toolBlocked(name: string, reason: string) {
      console.log('  ' + chalk.hex('#d4903a')(`⊘ ${name} blocked: ${reason}`));
    },

    warning(msg: string) {
      console.log('\n' + chalk.hex('#d4903a')(`  ⚠  ${msg}`));
    },

    success(msg: string) {
      console.log('\n' + chalk.hex('#5a9e6e')(`  ✓  ${msg}`));
    },

    error(msg: string) {
      console.error('\n' + chalk.hex('#b15439')(`  ✗  ${msg}`));
    },

    header(title: string, subtitle?: string) {
      const w = process.stdout.columns ?? 80;
      const line = '─'.repeat(Math.min(w - 4, 60));
      console.log('\n' + chalk.hex(FAINT_HEX)(line));
      console.log(chalk.hex('#cc785c').bold(`  ${title}`));
      if (subtitle) console.log(chalk.hex(TEXT_DIM_HEX)(`  ${subtitle}`));
      console.log(chalk.hex(FAINT_HEX)(line));
    },

    summary(text: string, turns: number, toolCount: number) {
      const w = process.stdout.columns ?? 80;
      const line = '─'.repeat(Math.min(w - 4, 60));
      console.log('\n' + chalk.hex(FAINT_HEX)(line));
      console.log(chalk.hex('#5a9e6e').bold('  ✓ Done'));
      console.log(chalk.hex(TEXT_DIM_HEX)(`  ${turns} turn${turns > 1 ? 's' : ''} · ${toolCount} tool call${toolCount > 1 ? 's' : ''}`));
      if (text) {
        console.log('');
        text.split('\n').forEach(l => console.log(chalk.hex(TEXT_HEX)(`  ${l}`)));
      }
      console.log(chalk.hex(FAINT_HEX)(line) + '\n');
    },

    retry(info) {
      const secs = (info.delayMs / 1000).toFixed(1);
      console.log(chalk.hex('#d4903a')(`  ⟳ ${info.provider} retrying in ${secs}s (attempt ${info.attempt}) — ${info.reason}`));
    },

    failover(info) {
      console.log(chalk.hex('#d4903a')(`  ⤳ Failing over ${info.from} → ${info.to} (${info.reason})`));
    },

    circuit(info) {
      const colour = info.state === 'open' ? '#b15439' : info.state === 'half-open' ? '#d4903a' : '#5a9e6e';
      console.log(chalk.hex(colour)(`  ◯ Circuit ${info.provider}: ${info.state}`));
    },

    contextBar(health) {
      console.log(formatContextBarFromHealth(health));
    },

    contextDashboard(health) {
      console.log(formatContextDashboard(health));
    },

    compactionEvent(info) {
      const saved = ((1 - info.afterTokens / info.beforeTokens) * 100).toFixed(0);
      console.log(chalk.hex('#d4903a')(`  ⚠  Context compacted: ${info.beforeTokens.toLocaleString()} → ${info.afterTokens.toLocaleString()} tokens (-${saved}%) · gen ${info.generation}`));
    },

    showPlan(plan: ExecutionPlan) {
      const w = process.stdout.columns ?? 80;
      const line = '─'.repeat(Math.min(w - 4, 60));
      // Build a position map so dependency arrows show step numbers, not raw UUIDs
      const idxMap = new Map<string, number>(plan.steps.map((s, i) => [s.id, i + 1]));
      console.log('\n' + chalk.hex(FAINT_HEX)(line));
      console.log(chalk.hex('#cc785c').bold('  Execution Plan'));
      console.log(chalk.hex(TEXT_DIM_HEX)(`  Goal: ${plan.goal}`));
      console.log(chalk.hex(FAINT_HEX)(line));
      plan.steps.forEach((s, i) => {
        const num    = chalk.hex(FAINT_HEX)(`${i + 1}.`);
        const spec   = chalk.hex('#cc785c').bold(`[${s.specialist}]`);
        const task   = chalk.hex(TEXT_HEX)(s.task.length > 55 ? s.task.slice(0, 52) + '…' : s.task);
        const deps   = s.dependsOn.length > 0
          ? chalk.hex(FAINT_HEX)(` ← ${s.dependsOn.map(d => idxMap.get(d) ?? '?').join(', ')}`)
          : '';
        console.log(`  ${num} ${spec} ${task}${deps}`);
      });
      console.log(chalk.hex(FAINT_HEX)(line) + '\n');
    },

    stepStarted(step: PlanStep) {
      const spec = chalk.hex('#d4903a').bold(`[${step.specialist}]`);
      const task = chalk.hex(TEXT_DIM_HEX)(step.task.length > 70 ? step.task.slice(0, 67) + '…' : step.task);
      console.log('\n' + chalk.hex('#d4903a')('  →') + ` ${spec} ${task}`);
    },

    stepCompleted(step: PlanStep, _result: string) {
      const spec = chalk.hex('#5a9e6e').bold(`[${step.specialist}]`);
      const ms   = step.durationMs != null ? `${step.durationMs}ms` : '?ms';
      console.log(chalk.hex('#5a9e6e')('  ✓') + ` ${spec} ${chalk.hex(FAINT_HEX)(`done (${ms})`)}`);
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toolIcon(name: string): string {
  const icons: Record<string, string> = {
    read_file: '📄', list_dir: '📁', edit_file: '✏️',
    write_file: '📝', search_code: '🔍', run_shell: '⚡',
    run_tests: '🧪', git_status: '🌿', git_diff: '📊',
  };
  return icons[name] ?? '🔧';
}

function formatInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read_file': {
      const r = input.start_line ? ` :${input.start_line}-${input.end_line ?? '?'}` : '';
      return `${input.path}${r}`;
    }
    case 'list_dir':   return `${input.path ?? '.'}${input.recursive ? ' (recursive)' : ''}`;
    case 'edit_file':  return `${input.path}`;
    case 'write_file': return `${input.path}`;
    case 'search_code': return `"${input.pattern}"${input.path ? ` in ${input.path}` : ''}`;
    case 'run_shell':  return String(input.command);
    case 'run_tests':  return input.file_or_pattern ? String(input.file_or_pattern) : 'all tests';
    case 'git_diff':   return input.path ? String(input.path) : 'all files';
    default:           return JSON.stringify(input).slice(0, 60);
  }
}

/**
 * One-line context-usage bar used by tests and any direct callers.
 * Clamps the visual fill to the bar width but keeps the true percentage in text
 * so over-limit usage (cumulative session tokens vs a single model window) is
 * visible rather than hidden.
 */
export function formatContextBar(usedTokens: number, limitTokens: number, isEstimated = false): string {
  const barWidth = 10;
  const pct = limitTokens > 0 ? (usedTokens / limitTokens) * 100 : 0;
  const filled = Math.max(0, Math.min(barWidth, Math.round((usedTokens / Math.max(1, limitTokens)) * barWidth)));
  const empty = barWidth - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const label = isEstimated ? `~${usedTokens.toLocaleString()} (estimated)` : usedTokens.toLocaleString();
  return `  ◆ Context: ${bar} ${pct.toFixed(0)}% (${label} / ${limitTokens.toLocaleString()})`;
}
