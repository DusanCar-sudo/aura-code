import type { Episode } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// formatStats — pure function for testability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a human-readable statistics summary from a list of episodes.
 * Pure function — no I/O, always returns a string.
 */
export function formatStats(episodes: Episode[]): string {
  if (episodes.length === 0) {
    return [
      '',
      '  Aura Stats',
      '',
      '  Episodes recorded:  0',
      '  Tasks completed:    0 (0%)',
      '  Avg duration:       —',
      '  Top model:          —',
      '  Total tokens used:  0',
      '',
    ].join('\n');
  }

  const total = episodes.length;
  const completed = episodes.filter(e => e.reviewerApproved).length;
  const completePct = total === 0 ? 0 : Math.round((completed / total) * 100);

  // Average duration
  const avgDurationMs =
    episodes.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / total;
  const avgDurationStr = formatDuration(avgDurationMs);

  // Top model by task count and success rate
  const modelStats = new Map<
    string,
    { tasks: number; successes: number; inputTokens: number; outputTokens: number }
  >();

  let totalTokens = 0;

  for (const ep of episodes) {
    const model = ep.largeModelUsed ?? (ep.rubySucceeded ? 'ruby' : undefined);
    if (model) {
      const existing = modelStats.get(model) ?? {
        tasks: 0,
        successes: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      existing.tasks += 1;
      if (ep.reviewerApproved) existing.successes += 1;
      // Episodes only have a single tokensUsed bucket, not split by input/output.
      // Treat largeModel tokens as input tokens for reporting purposes.
      const largeTokens = ep.tokensUsed?.largeModel ?? 0;
      const rubyTokens = ep.tokensUsed?.ruby ?? 0;
      existing.inputTokens += largeTokens + rubyTokens;
      modelStats.set(model, existing);
    }

    // Episode.tokensUsed tracks per-model totals only — there is no
    // input/output split captured at recording time, so we report a single
    // honest total rather than inventing an "output" figure that was never
    // actually measured.
    totalTokens += ep.tokensUsed?.largeModel ?? 0;
    totalTokens += ep.tokensUsed?.ruby ?? 0;
  }

  let topModel = '—';
  if (modelStats.size > 0) {
    const sorted = Array.from(modelStats.entries()).sort(
      ([, a], [, b]) => b.tasks - a.tasks,
    );
    const [name, stats] = sorted[0];
    const successPct = stats.tasks === 0 ? 0 : Math.round((stats.successes / stats.tasks) * 100);
    topModel = `${name} (${stats.tasks} task${stats.tasks === 1 ? '' : 's'}, ${successPct}% success)`;
  }

  const tokensStr = formatTokenCount(totalTokens);

  return [
    '',
    '  Aura Stats',
    '',
    `  Episodes recorded:  ${total}`,
    `  Tasks completed:    ${completed} (${completePct}%)`,
    `  Avg duration:       ${avgDurationStr}`,
    `  Top model:          ${topModel}`,
    `  Total tokens used:  ${tokensStr}`,
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatTokenCount(n: number): string {
  if (n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
