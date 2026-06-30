import chalk from 'chalk';
import type { ExecutionPlan, PlanStep } from '../orchestration/types.js';

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
}

export function createTerminalDisplay(): Display {
  let inStream = false;
  let currentTool = '';

  return {
    agentThinking() {
      // Subtle indicator — don't spam
    },

    streamText(text: string) {
      if (!inStream) {
        process.stdout.write('\n' + chalk.hex('#c8b5a0')(''));
        inStream = true;
      }
      process.stdout.write(chalk.hex('#ede0cc')(text));
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

    toolCall(name: string, input: Record<string, unknown>) {
      process.stdout.write('\n');
      const icon = toolIcon(name);
      const label = chalk.hex('#cc785c').bold(`${icon} ${name}`);
      const detail = formatInput(name, input);
      console.log(`  ${label}  ${chalk.hex('#8a7768')(detail)}`);
    },

    toolResult(name: string, result: string, elapsedMs: number) {
      const lines = result.split('\n');
      const preview = lines.length > 8
        ? lines.slice(0, 8).join('\n') + chalk.hex('#4e3d30')(`\n  ... (${lines.length - 8} more lines)`)
        : result;

      const elapsed = chalk.hex('#4e3d30')(`${elapsedMs}ms`);
      const isError = result.startsWith('Error:') || result.startsWith('Tool error');

      if (isError) {
        console.log('  ' + chalk.hex('#b15439')('✗ ') + chalk.hex('#8a7768')(preview.replace(/\n/g, '\n    ')));
      } else {
        // Show a compact preview
        const firstLine = lines[0] ?? '';
        if (lines.length <= 3) {
          console.log('  ' + chalk.hex('#5a9e6e')('✓ ') + chalk.hex('#8a7768')(result));
        } else {
          console.log('  ' + chalk.hex('#5a9e6e')('✓ ') + chalk.hex('#8a7768')(`${firstLine}`) + chalk.hex('#4e3d30')(` (+${lines.length - 1} lines) ${elapsed}`));
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
      console.log('\n' + chalk.hex('#4e3d30')(line));
      console.log(chalk.hex('#cc785c').bold(`  ${title}`));
      if (subtitle) console.log(chalk.hex('#8a7768')(`  ${subtitle}`));
      console.log(chalk.hex('#4e3d30')(line));
    },

    summary(text: string, turns: number, toolCount: number) {
      const w = process.stdout.columns ?? 80;
      const line = '─'.repeat(Math.min(w - 4, 60));
      console.log('\n' + chalk.hex('#4e3d30')(line));
      console.log(chalk.hex('#5a9e6e').bold('  ✓ Done'));
      console.log(chalk.hex('#8a7768')(`  ${turns} turn${turns > 1 ? 's' : ''} · ${toolCount} tool call${toolCount > 1 ? 's' : ''}`));
      if (text) {
        console.log('');
        text.split('\n').forEach(l => console.log(chalk.hex('#c8b5a0')(`  ${l}`)));
      }
      console.log(chalk.hex('#4e3d30')(line) + '\n');
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

    showPlan(plan: ExecutionPlan) {
      const w = process.stdout.columns ?? 80;
      const line = '─'.repeat(Math.min(w - 4, 60));
      // Build a position map so dependency arrows show step numbers, not raw UUIDs
      const idxMap = new Map<string, number>(plan.steps.map((s, i) => [s.id, i + 1]));
      console.log('\n' + chalk.hex('#4e3d30')(line));
      console.log(chalk.hex('#cc785c').bold('  Execution Plan'));
      console.log(chalk.hex('#8a7768')(`  Goal: ${plan.goal}`));
      console.log(chalk.hex('#4e3d30')(line));
      plan.steps.forEach((s, i) => {
        const num    = chalk.hex('#4e3d30')(`${i + 1}.`);
        const spec   = chalk.hex('#cc785c').bold(`[${s.specialist}]`);
        const task   = chalk.hex('#c8b5a0')(s.task.length > 55 ? s.task.slice(0, 52) + '…' : s.task);
        const deps   = s.dependsOn.length > 0
          ? chalk.hex('#4e3d30')(` ← ${s.dependsOn.map(d => idxMap.get(d) ?? '?').join(', ')}`)
          : '';
        console.log(`  ${num} ${spec} ${task}${deps}`);
      });
      console.log(chalk.hex('#4e3d30')(line) + '\n');
    },

    stepStarted(step: PlanStep) {
      const spec = chalk.hex('#d4903a').bold(`[${step.specialist}]`);
      const task = chalk.hex('#8a7768')(step.task.length > 70 ? step.task.slice(0, 67) + '…' : step.task);
      console.log('\n' + chalk.hex('#d4903a')('  →') + ` ${spec} ${task}`);
    },

    stepCompleted(step: PlanStep, _result: string) {
      const spec = chalk.hex('#5a9e6e').bold(`[${step.specialist}]`);
      const ms   = step.durationMs != null ? `${step.durationMs}ms` : '?ms';
      console.log(chalk.hex('#5a9e6e')('  ✓') + ` ${spec} ${chalk.hex('#4e3d30')(`done (${ms})`)}`);
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
