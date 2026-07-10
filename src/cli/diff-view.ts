/**
 * Inline diff renderer — shows file edits as colored +/- lines,
 * like `git diff` but with Aura's palette.
 */
import chalk from 'chalk';
import { GOLD_DIM_HEX, RUBY_ACCENT } from './diamond.js';

const GOLD_DIM = chalk.hex(GOLD_DIM_HEX);
const RUBY = RUBY_ACCENT;
const ADDED = chalk.hex('#5a9e6e');
const REMOVED = chalk.hex('#b15439');
const HUNK_HEADER = chalk.hex('#4e3d30');
const FILE_HEADER = chalk.hex('#cc785c');

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'hunk' | 'file';
  content: string;
}

/**
 * Compute a simple line-level diff between old and new text.
 * Uses LCS-based approach for accuracy.
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const diff: DiffLine[] = [];

  // Simple LCS diff
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const traceDiff = (i: number, j: number) => {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      traceDiff(i - 1, j - 1);
      diff.push({ type: 'context', content: oldLines[i - 1] });
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      traceDiff(i, j - 1);
      diff.push({ type: 'add', content: newLines[j - 1] });
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      traceDiff(i - 1, j);
      diff.push({ type: 'remove', content: oldLines[i - 1] });
    }
  };

  traceDiff(m, n);
  return diff;
}

/**
 * Render a diff as styled terminal lines. Shows up to `maxLines` lines
 * of context, then collapses with a "... N more lines" marker.
 */
export function renderDiff(diff: DiffLine[], maxLines = 30): string[] {
  const lines: string[] = [];
  let shown = 0;
  let totalChanges = 0;

  for (const d of diff) {
    if (d.type === 'add' || d.type === 'remove') totalChanges++;
  }

  const maxChanges = Math.min(maxLines, totalChanges);
  let changeCount = 0;

  for (const d of diff) {
    if (d.type === 'add' || d.type === 'remove') {
      if (changeCount >= maxChanges) continue;
      changeCount++;
    }

    if (shown >= maxLines && d.type !== 'hunk' && d.type !== 'file') {
      const remaining = totalChanges - changeCount;
      if (remaining > 0) {
        lines.push(GOLD_DIM(`  … ${remaining} more changes`));
      }
      break;
    }
    shown++;

    switch (d.type) {
      case 'add':
        lines.push(ADDED(`  + ${d.content}`));
        break;
      case 'remove':
        lines.push(REMOVED(`  - ${d.content}`));
        break;
      case 'context':
        lines.push(GOLD_DIM(`  ${d.content}`));
        break;
    }
  }

  return lines;
}

/**
 * Quick diff preview for tool calls — shows a compact summary.
 */
export function diffPreview(oldText: string, newText: string, filePath: string): string[] {
  const diff = computeDiff(oldText, newText);
  const added = diff.filter(d => d.type === 'add').length;
  const removed = diff.filter(d => d.type === 'remove').length;

  const lines: string[] = [
    FILE_HEADER.bold(`  📝 ${filePath}`) + GOLD_DIM(`  +${added} -${removed}`),
  ];

  return [...lines, ...renderDiff(diff, 15)];
}
