/**
 * Kanban Prompt Optimization — Token Count Measurement
 *
 * Compares verbose vs minimal prompt templates for LLM kanban updates.
 * The goal: keep the agent's context window lean over long multi-hour sessions.
 *
 * Run: npx ts-node src/kanban/prompt-optimization.ts
 */

// ── Token estimation ─────────────────────────────────────────────────────────
// Rough but consistent: ~4 chars per token for English text.
// We use both char-count/4 and a simple word-based estimator for cross-check.

function estimateTokens(text: string): number {
  // GPT/Claude tokenizer approximation: ~4 chars per token
  const charEstimate = Math.ceil(text.length / 4);
  // Word-based: ~1.3 tokens per word
  const wordCount = text.split(/\s+/).length;
  const wordEstimate = Math.ceil(wordCount * 1.3);
  // Return the more conservative (higher) estimate
  return Math.max(charEstimate, wordEstimate);
}

// ── Verbose template (old way) ───────────────────────────────────────────────

function verbosePrompt(cardId: string, title: string, from: string, to: string, reason: string): string {
  return `I am updating the kanban board to reflect my current work status.

The card I am working on is "${title}" (ID: ${cardId}).
This card was previously in the "${from}" column.
I am now moving it to the "${to}" column.

The reason for this move is: ${reason}.

This update reflects the current state of my work on this task.
I will continue to update the board as my work progresses.`;
}

// ── Minimal template (new way — structured diff) ─────────────────────────────

function minimalPrompt(cardId: string, title: string, from: string, to: string, reason: string): string {
  return `Kanban: ${cardId} "${title}" ${from}→${to} (${reason})`;
}

// ── Measurement ──────────────────────────────────────────────────────────────

interface Measurement {
  label: string;
  template: string;
  chars: number;
  tokens: number;
}

function measure(label: string, template: string): Measurement {
  return {
    label,
    template,
    chars: template.length,
    tokens: estimateTokens(template),
  };
}

// ── Scenarios ────────────────────────────────────────────────────────────────

const scenarios = [
  { cardId: 'kb-a1b2c3d4', title: 'Token Optimization', from: 'todo', to: 'in-progress', reason: 'Starting implementation' },
  { cardId: 'kb-e5f6g7h8', title: 'Cross-Provider Prompts', from: 'in-progress', to: 'review', reason: 'Ready for review' },
  { cardId: 'kb-i9j0k1l2', title: 'Failure Analysis', from: 'review', to: 'done', reason: 'Verified and merged' },
  { cardId: 'kb-m3n4o5p6', title: 'Competence Scoring', from: 'backlog', to: 'todo', reason: 'Prioritized for next sprint' },
  { cardId: 'kb-q7r8s9t0', title: 'File Patch Operations', from: 'todo', to: 'in-progress', reason: 'High priority, starting now' },
];

// ── Report ───────────────────────────────────────────────────────────────────

console.log('='.repeat(72));
console.log('Kanban Prompt Optimization — Token Count Comparison');
console.log('='.repeat(72));
console.log('');

let totalVerboseChars = 0;
let totalVerboseTokens = 0;
let totalMinimalChars = 0;
let totalMinimalTokens = 0;

for (const s of scenarios) {
  const verbose = verbosePrompt(s.cardId, s.title, s.from, s.to, s.reason);
  const minimal = minimalPrompt(s.cardId, s.title, s.from, s.to, s.reason);

  const v = measure('Verbose', verbose);
  const m = measure('Minimal', minimal);

  totalVerboseChars += v.chars;
  totalVerboseTokens += v.tokens;
  totalMinimalChars += m.chars;
  totalMinimalTokens += m.tokens;

  console.log(`Scenario: "${s.title}" (${s.from} → ${s.to})`);
  console.log(`  Verbose: ${v.chars} chars, ~${v.tokens} tokens`);
  console.log(`  Minimal: ${m.chars} chars, ~${m.tokens} tokens`);
  console.log(`  Saved:   ${v.chars - m.chars} chars, ~${v.tokens - m.tokens} tokens (${Math.round((1 - m.tokens / v.tokens) * 100)}%)`);
  console.log('');
}

console.log('-'.repeat(72));
console.log('Totals (5 moves):');
console.log(`  Verbose: ${totalVerboseChars} chars, ~${totalVerboseTokens} tokens`);
console.log(`  Minimal: ${totalMinimalChars} chars, ~${totalMinimalTokens} tokens`);
console.log(`  Saved:   ${totalVerboseChars - totalMinimalChars} chars, ~${totalVerboseTokens - totalMinimalTokens} tokens`);
console.log('');

// Extrapolate to 50 moves (typical long session)
console.log('-'.repeat(72));
console.log('Extrapolation (50 moves per session):');
const perMoveVerboseTokens = totalVerboseTokens / scenarios.length;
const perMoveMinimalTokens = totalMinimalTokens / scenarios.length;
console.log(`  Verbose: ~${perMoveVerboseTokens * 50} tokens`);
console.log(`  Minimal: ~${perMoveMinimalTokens * 50} tokens`);
console.log(`  Context saved: ~${(perMoveVerboseTokens - perMoveMinimalTokens) * 50} tokens per session`);
console.log('');

// Show the actual templates
console.log('-'.repeat(72));
console.log('Template Comparison (first scenario):');
console.log('');
console.log('VERBOSE:');
console.log(verbosePrompt(scenarios[0].cardId, scenarios[0].title, scenarios[0].from, scenarios[0].to, scenarios[0].reason));
console.log('');
console.log('MINIMAL:');
console.log(minimalPrompt(scenarios[0].cardId, scenarios[0].title, scenarios[0].from, scenarios[0].to, scenarios[0].reason));
console.log('');
console.log('='.repeat(72));
