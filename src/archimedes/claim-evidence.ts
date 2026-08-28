// ─────────────────────────────────────────────────────────────────────────────
// Claim-aware evidence selection
//
// The verifier's whole job is detecting contradiction between an answer and the
// evidence the tools actually returned. It used to see the first 300 characters
// of each tool result — on a real file read, roughly 6% of the evidence, and
// almost never the part the answer is talking about. A verifier shown the
// license header of a file cannot tell you whether a claim about a function on
// line 400 is a fabrication.
//
// So: pull the checkable terms out of the ANSWER (file paths, symbols, line
// refs, quoted spans), then keep the spans of each tool result that mention
// them, truncating the rest. Same order of magnitude of tokens; vastly higher
// odds that the contradicting sentence is actually in the prompt.
//
// A result matching nothing still contributes its head, because "this tool
// returned something shaped like X" is itself weak evidence.
// ─────────────────────────────────────────────────────────────────────────────

/** Characters of context kept either side of a matched term. */
const WINDOW_CHARS = 100;
/** Per-result ceiling once windows are merged. */
export const PER_RESULT_BUDGET = 600;
/** Ceiling across all results, so a long session cannot blow up the prompt. */
export const TOTAL_EVIDENCE_BUDGET = 8_000;
/** Head kept from a result that matches no claim term. */
const UNMATCHED_HEAD_CHARS = 200;

/** Words too common to be evidence of anything. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'from', 'has', 'have', 'not',
  'are', 'was', 'were', 'but', 'you', 'your', 'its', 'it', 'is', 'in', 'on',
  'of', 'to', 'a', 'an', 'as', 'at', 'by', 'or', 'be', 'been', 'which', 'when',
  'file', 'files', 'code', 'line', 'lines', 'function', 'class', 'method',
  'returns', 'return', 'value', 'values', 'string', 'number', 'boolean',
  'true', 'false', 'null', 'undefined', 'type', 'types', 'const', 'let', 'var',
  'import', 'export', 'default', 'async', 'await', 'if', 'else', 'while',
]);

/**
 * Checkable terms from an answer — the things a tool result could contradict.
 *
 * Deliberately biased toward the specific: a path, a symbol, a line number and
 * a quoted span can each be checked against evidence, whereas prose cannot.
 * Ordered most-distinctive first so budget pressure drops the vaguest terms.
 */
export function extractClaimTerms(answer: string): string[] {
  const terms = new Map<string, number>(); // term -> rank (lower = more specific)

  const add = (raw: string, rank: number): void => {
    const term = raw.trim();
    if (term.length < 3) return;
    if (STOPWORDS.has(term.toLowerCase())) return;
    const existing = terms.get(term);
    if (existing === undefined || rank < existing) terms.set(term, rank);
  };

  // 1. Backtick-quoted spans — the author marked these as literal.
  for (const m of answer.matchAll(/`([^`\n]{2,80})`/g)) add(m[1], 0);

  // 2. File paths, with or without a line ref.
  for (const m of answer.matchAll(/\b[\w.-]+(?:\/[\w.-]+)+(?:\.\w{1,8})?\b/g)) add(m[0], 1);
  for (const m of answer.matchAll(/\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|rb|sh|yml|yaml|toml)\b/gi)) {
    add(m[0], 1);
  }

  // 3. Line references — "line 412", "foo.ts:412".
  for (const m of answer.matchAll(/:(\d{1,6})\b/g)) add(m[1], 2);
  for (const m of answer.matchAll(/\bline\s+(\d{1,6})\b/gi)) add(m[1], 2);

  // 4. Symbol-shaped identifiers: camelCase, PascalCase, snake_case, CONST_CASE.
  for (const m of answer.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g)) add(m[0], 3);
  for (const m of answer.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g)) add(m[0], 3);
  for (const m of answer.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi)) add(m[0], 3);
  for (const m of answer.matchAll(/\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)*\b/g)) add(m[0], 3);

  return [...terms.entries()]
    .sort((a, b) => a[1] - b[1] || b[0].length - a[0].length)
    .map(([term]) => term);
}

interface Span { start: number; end: number }

/** Merge overlapping/adjacent spans so the excerpt reads continuously. */
function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [sorted[0]];
  for (const span of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * The portion of one tool result worth showing the verifier: windows around
 * every claim term it mentions, merged, capped at `budget`.
 *
 * Returns the head of the content when nothing matches — a result that
 * corroborates nothing in the answer is still context about what ran.
 */
export function claimAwareExcerpt(
  content: string,
  terms: string[],
  budget: number = PER_RESULT_BUDGET,
): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= budget) return flat;

  const haystack = flat.toLowerCase();
  const spans: Span[] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    let from = 0;
    // Cap repeats per term so one ubiquitous identifier cannot eat the budget.
    for (let hits = 0; hits < 3; hits++) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      spans.push({
        start: Math.max(0, at - WINDOW_CHARS),
        end: Math.min(flat.length, at + needle.length + WINDOW_CHARS),
      });
      from = at + needle.length;
    }
    // Terms are ordered most-specific first; stop once the budget is covered.
    const covered = mergeSpans(spans).reduce((n, s) => n + (s.end - s.start), 0);
    if (covered >= budget) break;
  }

  if (spans.length === 0) {
    return flat.slice(0, Math.min(UNMATCHED_HEAD_CHARS, budget)) + '…';
  }

  const merged = mergeSpans(spans);
  const parts: string[] = [];
  let used = 0;
  for (const span of merged) {
    if (used >= budget) break;
    const slice = flat.slice(span.start, Math.min(span.end, span.start + (budget - used)));
    if (!slice) continue;
    parts.push((span.start > 0 ? '…' : '') + slice);
    used += slice.length;
  }
  const tail = merged[merged.length - 1].end < flat.length ? '…' : '';
  return parts.join('') + tail;
}
