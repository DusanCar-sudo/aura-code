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
      const w = Math.min((process.stdout.columns ?? 80) - 2, 144);
      const pad = (s: string) => `  ${s}`;
      console.log('');
      console.log(boxTop(w));
      console.log(boxLine(chalk.hex('#cc785c').bold(pad(title)), w));
      if (subtitle) console.log(boxLine(chalk.hex('#8a7768')(pad(subtitle)), w));
      console.log(boxBottom(w));
    },

    summary(text: string, turns: number, toolCount: number) {
      const w = Math.min((process.stdout.columns ?? 80) - 2, 144);
      const pad = (s: string) => `  ${s}`;
      console.log('');
      console.log(boxTop(w));
      console.log(boxLine(chalk.hex('#5a9e6e').bold(pad('✓ Done')), w));
      console.log(boxLine(chalk.hex('#8a7768')(pad(`${turns} turn${turns > 1 ? 's' : ''} · ${toolCount} tool call${toolCount > 1 ? 's' : ''}`)), w));
      if (text) {
        const innerWidth = Math.max(w - 4, 10); // w - 2 (border chars) - 2 (pad()'s leading spaces)
        text.split('\n').forEach(l => {
          wrapLine(l, innerWidth).forEach(wl => console.log(boxLine(chalk.hex('#c8b5a0')(pad(wl)), w)));
        });
      }
      console.log(boxBottom(w) + '\n');
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
      const w = Math.min((process.stdout.columns ?? 80) - 2, 144);
      const pad = (s: string) => `  ${s}`;
      // Build a position map so dependency arrows show step numbers, not raw UUIDs
      const idxMap = new Map<string, number>(plan.steps.map((s, i) => [s.id, i + 1]));
      console.log('');
      console.log(boxTop(w));
      console.log(boxLine(chalk.hex('#cc785c').bold(pad('Execution Plan')), w));
      console.log(boxLine(chalk.hex('#8a7768')(pad(`Goal: ${plan.goal}`)), w));
      plan.steps.forEach((s, i) => {
        const num    = chalk.hex('#4e3d30')(`${i + 1}.`);
        const spec   = chalk.hex('#cc785c').bold(`[${s.specialist}]`);
        const task   = chalk.hex('#c8b5a0')(s.task.length > 55 ? s.task.slice(0, 52) + '…' : s.task);
        const deps   = s.dependsOn.length > 0
          ? chalk.hex('#4e3d30')(` ← ${s.dependsOn.map(d => idxMap.get(d) ?? '?').join(', ')}`)
          : '';
        console.log(boxLine(`  ${num} ${spec} ${task}${deps}`, w));
      });
      console.log(boxBottom(w) + '\n');
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

// ── Box-drawing helpers ──────────────────────────────────────────────────────

/** Render a colored top border: ┌──────────┐ */
function boxTop(width: number, color = '#4e3d30'): string {
  const inner = '─'.repeat(Math.max(width - 2, 2));
  return chalk.hex(color)(`┌${inner}┐`);
}

/** Word-wrap a single line to fit within `width` visible characters. Breaks
 *  on whitespace; a token longer than `width` alone is hard-broken rather
 *  than left to overflow. Used so long lines (markdown table rows, bullet
 *  points) flow across multiple box lines instead of being truncated. */
function wrapLine(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const words = text.split(' ');
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    if (word.length > width) {
      if (current) { out.push(current); current = ''; }
      for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Render a colored bottom border: └──────────┘ */
function boxBottom(width: number, color = '#4e3d30'): string {
  const inner = '─'.repeat(Math.max(width - 2, 2));
  return chalk.hex(color)(`└${inner}┘`);
}

/** Render a colored side-padded line: │  content          │ */
function boxLine(text: string, width: number, color = '#4e3d30'): string {
  const maxInner = Math.max(width - 2, 2);
  // Strip ANSI to measure visible length
  const visible = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length > maxInner) {
    // Truncate with ellipsis to prevent box overflow.
    // Reserve 1 visible char for '…' so total = 1 + (truncLen + 1) + 1 = width.
    const truncLen = Math.max(maxInner - 1, 1);
    // Walk text char-by-char to preserve ANSI boundaries during truncation
    let visCount = 0;
    let idx = 0;
    const chars = [...text];
    while (idx < chars.length && visCount < truncLen) {
      if (chars[idx] === '\x1b') {
        // Skip the entire ANSI escape sequence
        while (idx < chars.length && chars[idx] !== 'm') idx++;
        idx++; // skip the 'm' terminator
      } else {
        visCount++;
        idx++;
      }
    }
    const truncated = text.slice(0, idx) + '…';
    return chalk.hex(color)('│') + truncated + chalk.hex(color)('│');
  }
  const padding = maxInner - visible.length;
  return chalk.hex(color)('│') + text + ' '.repeat(padding) + chalk.hex(color)('│');
}

// ── Context bar helpers ──────────────────────────────────────────────────────

/** Format a token count compactly: 1234 → "1.2K", 25400 → "25.4K", 1000000 → "1M". */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + 'M';
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + 'K';
  }
  return String(n);
}

/** Build the context-bar line, e.g. `  25.4K/1M │ [████░░░░░░] 23%`. */
export function formatContextBar(
  used: number,
  limit: number,
  estimated: boolean,
): string {
  const pct = Math.round((used / limit) * 100);
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  const bar = chalk.hex('#cc785c')('█'.repeat(filled)) + chalk.hex('#4e3d30')('░'.repeat(empty));

  const left = estimated
    ? chalk.hex('#d4903a')(`~${formatCompact(used)}`)
    : chalk.hex('#5a9e6e')(formatCompact(used));
  const right = chalk.hex('#8a7768')(formatCompact(limit));
  const pctStr = estimated
    ? chalk.hex('#d4903a')(`${pct}%`)
    : chalk.hex('#8a7768')(`${pct}%`);

  const estTag = estimated ? chalk.hex('#4e3d30')(' (estimated)') : '';

  return `  ${left}/${right} │ [${bar}] ${pctStr}${estTag}`;
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
