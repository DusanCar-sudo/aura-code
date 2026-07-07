/**
 * Context Health Dashboard — real-time visibility into token usage,
 * compaction state, and session costs. Observational only — never
 * modifies history or triggers compaction.
 */
import chalk from 'chalk';
import type { HistoryMessage } from '../providers/types.js';
import { estimateContextTokens, countMessage, countText, getRecapGeneration } from '../agent/compactor.js';
import { getContextWindow } from '../providers/factory.js';
import { costFor } from '../agent/loop.js';

const LADDER = [0.55, 0.70, 0.85] as const;
const ROLLOVER_AT_GENERATION = 3;
const DEFAULT_WINDOW = 128_000;

export interface LargestMessage {
  role: string;
  preview: string;
  tokens: number;
  index: number;
}

export interface CompactionEvent {
  turn: number;
  beforeTokens: number;
  afterTokens: number;
  generation: number;
}

export interface ContextHealth {
  estimatedTokens: number;
  contextWindow: number;
  usagePercent: number;
  recapGeneration: number;
  nextCompactionThreshold: number;
  nextCompactionPercent: number;
  tokensUntilCompaction: number;
  rolloversRemaining: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  turnCount: number;
  toolCallCount: number;
  compactionCount: number;
  largestMessages: LargestMessage[];
  compactionHistory: CompactionEvent[];
}

export class ContextHealthTracker {
  private compactionEvents: CompactionEvent[] = [];
  private _turnCount = 0;
  private _toolCallCount = 0;

  constructor(
    private getSystem: () => string,
    private getHistory: () => HistoryMessage[],
    private model: string,
    private pricingModel: string,
  ) {}

  incrementTurn() { this._turnCount++; }
  incrementToolCalls(n = 1) { this._toolCallCount += n; }

  /** Replace the system-prompt source — used when a shared tracker is passed
   *  into the loop and the loop builds the real (task-embedded) system prompt. */
  updateSystem(s: string) { this.getSystem = () => s; }

  recordCompaction(beforeTokens: number, afterTokens: number, generation: number) {
    this.compactionEvents.push({ turn: this._turnCount, beforeTokens, afterTokens, generation });
  }

  snapshot(inputTokens = 0, outputTokens = 0): ContextHealth {
    const system = this.getSystem();
    const history = this.getHistory();
    const estimatedTokens = estimateContextTokens(system, history);
    const contextWindow = getContextWindow(this.model) ?? DEFAULT_WINDOW;
    const usagePercent = (estimatedTokens / contextWindow) * 100;
    const recapGeneration = getRecapGeneration(history);
    const genIndex = Math.min(recapGeneration, LADDER.length - 1);
    const nextCompactionPercent = Math.round(LADDER[genIndex] * 100);
    const nextCompactionThreshold = Math.floor(contextWindow * LADDER[genIndex]);
    const tokensUntilCompaction = Math.max(0, nextCompactionThreshold - estimatedTokens);

    return {
      estimatedTokens, contextWindow, usagePercent, recapGeneration,
      nextCompactionThreshold, nextCompactionPercent, tokensUntilCompaction,
      rolloversRemaining: Math.max(0, ROLLOVER_AT_GENERATION - recapGeneration),
      totalInputTokens: inputTokens, totalOutputTokens: outputTokens,
      totalCostUsd: costFor(this.pricingModel, inputTokens, outputTokens),
      turnCount: this._turnCount, toolCallCount: this._toolCallCount,
      compactionCount: this.compactionEvents.length,
      largestMessages: getLargestMessages(history, system, 5),
      compactionHistory: [...this.compactionEvents],
    };
  }
}

function getLargestMessages(history: HistoryMessage[], system: string, n: number): LargestMessage[] {
  const messages: LargestMessage[] = [];
  messages.push({ role: 'system', preview: 'System prompt', tokens: countText(system), index: -1 });
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    const tokens = countMessage(msg);
    let preview: string;
    switch (msg.role) {
      case 'user': preview = msg.content?.slice(0, 60) ?? '(empty)'; break;
      case 'assistant': preview = msg.content?.slice(0, 60) || (msg.toolCalls?.length ? 'Calls: ' + msg.toolCalls.map(c => c.name).join(', ') : '(empty)'); break;
      case 'tool_result': preview = 'Tool: ' + msg.results.map(r => r.name).join(', '); break;
      default: preview = '(unknown)';
    }
    messages.push({ role: msg.role, preview, tokens, index: i });
  }
  return messages.sort((a, b) => b.tokens - a.tokens).slice(0, n);
}

export function formatContextBar(h: ContextHealth): string {
  const barWidth = 20;
  const filled = Math.max(0, Math.min(barWidth, Math.round((h.usagePercent / 100) * barWidth)));
  const ladderPos = LADDER.map(r => Math.floor(r * barWidth));
  let bar = '';
  for (let i = 0; i < barWidth; i++) {
    if (i < filled) bar += '\u2588';
    else if (ladderPos.includes(i)) bar += '\u250a';
    else bar += '\u2591';
  }
  const barColor = h.usagePercent < 50 ? chalk.hex('#5a9e6e') : h.usagePercent < 70 ? chalk.hex('#d4903a') : chalk.hex('#b15439');
  const pct = h.usagePercent.toFixed(0) + '%';
  const tok = (h.estimatedTokens / 1000).toFixed(1) + 'k/' + (h.contextWindow / 1000).toFixed(0) + 'k';
  const gen = h.recapGeneration > 0 ? ' \u00b7 gen ' + h.recapGeneration : '';
  const compact = ' \u00b7 compact @ ' + h.nextCompactionPercent + '% (' + (h.nextCompactionThreshold / 1000).toFixed(0) + 'k)';
  const cost = h.totalCostUsd > 0 ? ' \u00b7 $' + h.totalCostUsd.toFixed(2) : '';
  return '  \u25c6 Context: ' + barColor(bar) + ' ' + pct + ' (' + tok + ')' + gen + compact + cost + ' \u00b7 ' + h.turnCount + ' turns';
}

export function formatContextDashboard(h: ContextHealth): string {
  const w = process.stdout.columns ?? 80;
  const line = '\u2500'.repeat(Math.min(w - 4, 60));
  const barWidth = 30;
  const filled = Math.max(0, Math.min(barWidth, Math.round((h.usagePercent / 100) * barWidth)));
  const ladderPos = LADDER.map(r => Math.floor(r * barWidth));
  let bar = '';
  for (let i = 0; i < barWidth; i++) {
    if (i < filled) bar += '\u2588';
    else if (ladderPos.includes(i)) bar += '\u250a';
    else bar += '\u2591';
  }
  const barColor = h.usagePercent < 50 ? chalk.hex('#5a9e6e') : h.usagePercent < 70 ? chalk.hex('#d4903a') : chalk.hex('#b15439');
  const freeTokens = Math.max(0, h.contextWindow - h.estimatedTokens);
  const freePct = (100 - Math.min(100, h.usagePercent)).toFixed(0);

  const lines: string[] = [
    '',
    chalk.hex('#4e3d30')(line),
    chalk.hex('#cc785c').bold('  Context Health Dashboard'),
    chalk.hex('#4e3d30')(line),
    '',
    '  Window:    ' + chalk.hex('#c8b5a0')(h.contextWindow.toLocaleString()) + ' tokens',
    '  Used:      ' + chalk.hex('#c8b5a0')(h.estimatedTokens.toLocaleString()) + ' tokens (' + chalk.bold(h.usagePercent.toFixed(1) + '%') + ') ' + barColor(bar),
    '  Free:      ' + chalk.hex('#c8b5a0')(freeTokens.toLocaleString()) + ' tokens (' + freePct + '%)',
    '',
    '  Compaction: ' + chalk.hex('#c8b5a0')('Generation ' + h.recapGeneration + ' of ' + ROLLOVER_AT_GENERATION),
    '  Next fire:  ' + chalk.hex('#c8b5a0')(h.nextCompactionThreshold.toLocaleString() + ' tokens (' + h.nextCompactionPercent + '%)') + ' \u2014 ' + chalk.hex('#d4903a')(h.tokensUntilCompaction.toLocaleString() + ' tokens away'),
    '  Ladder:     ' + formatLadder(h.recapGeneration),
    '  Remaining:  ' + chalk.hex('#c8b5a0')(h.rolloversRemaining + ' compaction(s) before dream flush'),
    '',
    chalk.hex('#cc785c').bold('  Session totals'),
    '    Input:    ' + chalk.hex('#c8b5a0')(h.totalInputTokens.toLocaleString()) + ' tokens',
    '    Output:   ' + chalk.hex('#c8b5a0')(h.totalOutputTokens.toLocaleString()) + ' tokens',
    '    Cost:     ' + chalk.hex('#c8b5a0')('$' + h.totalCostUsd.toFixed(4)),
    '    Turns:    ' + chalk.hex('#c8b5a0')(String(h.turnCount)),
    '    Tools:    ' + chalk.hex('#c8b5a0')(h.toolCallCount + ' calls'),
  ];

  if (h.compactionHistory.length > 0) {
    lines.push('', chalk.hex('#cc785c').bold('  Compaction history'));
    for (const e of h.compactionHistory) {
      const saved = ((1 - e.afterTokens / e.beforeTokens) * 100).toFixed(0);
      lines.push('    Turn ' + e.turn + ': ' + e.beforeTokens.toLocaleString() + ' \u2192 ' + e.afterTokens.toLocaleString() + ' tokens ' + chalk.hex('#5a9e6e')('(-' + saved + '%)') + ' gen ' + (e.generation - 1) + '\u2192' + e.generation);
    }
  }

  if (h.largestMessages.length > 0) {
    lines.push('', chalk.hex('#cc785c').bold('  Largest messages'));
    for (const m of h.largestMessages) {
      const idx = m.index === -1 ? 'sys' : '#' + m.index;
      lines.push('    ' + chalk.hex('#4e3d30')(idx.padEnd(4)) + ' ' + chalk.hex('#8a7768')(m.role.padEnd(12)) + ' ' + m.preview + ' ' + chalk.hex('#d4903a')(m.tokens.toLocaleString() + ' tok'));
    }
  }

  lines.push('', chalk.hex('#4e3d30')(line), '');
  return lines.join('\n');
}

function formatLadder(generation: number): string {
  const rungs = LADDER.map((r, i) => {
    const pct = (r * 100).toFixed(0) + '%';
    if (i < generation) return chalk.hex('#5a9e6e')(pct + ' \u2713');
    if (i === generation) return chalk.hex('#d4903a')(pct + ' pending');
    return chalk.hex('#4e3d30')(pct);
  });
  const flush = chalk.hex('#6d8fb3')('flush');
  return rungs.join(' \u2192 ') + ' \u2192 ' + flush;
}

export function formatCompactionEvent(beforeTokens: number, afterTokens: number, generation: number, threshold: number): string {
  const saved = ((1 - afterTokens / beforeTokens) * 100).toFixed(0);
  return 'Context compacted: ' + beforeTokens.toLocaleString() + ' \u2192 ' + afterTokens.toLocaleString() + ' tokens ' + chalk.hex('#5a9e6e')('(-' + saved + '%)') + ' \u00b7 gen ' + generation + ' \u00b7 threshold ' + threshold.toLocaleString();
}
