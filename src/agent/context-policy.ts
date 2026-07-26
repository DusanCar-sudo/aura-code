/**
 * Compaction policy — the single source of truth for the trigger ladder.
 *
 * The ladder used to be a `const` duplicated in compactor.ts (what actually
 * fires) and context-health.ts (what the bar draws). Once the ladder became
 * user-configurable that duplication turned into a live defect: the footer
 * would confidently report thresholds the engine wasn't using. Both now read
 * from here.
 *
 * Process-scoped mutable state is deliberate. One CLI process serves one
 * project with one resolved config, so threading a policy object through
 * every compaction call site would be ceremony without benefit. `setLadder`
 * is called once at startup from the resolved project config, and again by
 * the interactive tuner (/context tune) when the user commits a change.
 */

/**
 * Escalating trigger ladder, indexed by "recap generation" (how many times
 * the current recap has already been through compaction). Later generations
 * tolerate more fill before firing again — that content is already dense/
 * pre-summarized, so there's less marginal value in acting early.
 */
export const DEFAULT_LADDER: readonly number[] = [0.55, 0.70, 0.85];

/**
 * Absolute ceiling on context before compaction fires, in tokens.
 *
 * The ladder alone is a share of the context window, which is the wrong unit
 * for a cost control: the window is a *capability* limit, while cost is
 * absolute dollars per million tokens. On a 1M-token model, rung 1 sits at
 * 550k — a session can carry 200k+ tokens on every turn and never trigger
 * compaction, paying for the full history on each call. (Observed: a session
 * that grew monotonically to 218k tokens over 216 calls and compacted zero
 * times, because it never approached 550k.)
 *
 * 80k is chosen so this is a no-op for models that were already fine: at a
 * 128k window rung 1 is 70.4k, below the cap, so nothing changes. It only
 * binds on large-window models (200k, 1M), which is exactly where the ladder
 * stops being a meaningful bound.
 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 80_000;

/**
 * Verbatim recent-history budget kept through compaction, as a share of the
 * window. 40% preserves interaction nuance over long sequences. Lives here
 * (not compactor.ts) so the threshold and retention rules stay together and
 * compactor.ts can import from policy without a cycle.
 */
export const RETENTION_RATIO = 0.40;

/** Post-compaction headroom guard: retention may never exceed this share of
 *  the trigger, or compaction would fire again almost immediately. */
const MAX_RETENTION_OF_TRIGGER = 0.75;

/** Hard bounds for any rung. Below 5% compaction would fire on an empty
 *  history; at/above 95% there isn't enough headroom left for the recap
 *  call itself to fit before the provider rejects the request. */
export const MIN_RUNG = 0.05;
export const MAX_RUNG = 0.95;

/** Smallest gap enforced between adjacent rungs, so they can never cross
 *  or collapse onto each other (the "handles don't cross" constraint). */
export const MIN_GAP = 0.01;

let ladder: readonly number[] = DEFAULT_LADDER;
let maxContextTokens: number = DEFAULT_MAX_CONTEXT_TOKENS;

/** The ladder currently in force. Never empty. */
export function getLadder(): readonly number[] {
  return ladder;
}

/**
 * Coerce an arbitrary user-supplied ladder into a valid one: drop
 * non-finite entries, clamp into range, sort ascending, and push apart any
 * rungs closer than MIN_GAP. Returns DEFAULT_LADDER if nothing usable
 * survives, so a malformed .aura.json degrades to working defaults rather
 * than disabling compaction entirely.
 */
export function normalizeLadder(input: readonly number[]): number[] {
  const cleaned = input
    .filter((r) => Number.isFinite(r))
    .map((r) => Math.min(MAX_RUNG, Math.max(MIN_RUNG, r)))
    .sort((a, b) => a - b);

  if (cleaned.length === 0) return [...DEFAULT_LADDER];

  // Separate left-to-right, which can push the tail past MAX_RUNG...
  for (let i = 1; i < cleaned.length; i++) {
    if (cleaned[i] - cleaned[i - 1] < MIN_GAP) {
      cleaned[i] = cleaned[i - 1] + MIN_GAP;
    }
  }
  // ...so pin the top and separate right-to-left. This pass is unconditional:
  // gating it on "does this rung exceed MAX_RUNG" leaves a rung that was
  // pushed *down* still overlapping its own lower neighbour.
  cleaned[cleaned.length - 1] = Math.min(cleaned[cleaned.length - 1], MAX_RUNG);
  for (let i = cleaned.length - 1; i > 0; i--) {
    cleaned[i - 1] = Math.min(cleaned[i - 1], cleaned[i] - MIN_GAP);
  }

  // A ladder with more rungs than the legal range can hold at MIN_GAP has
  // just been pushed below the floor. Nothing to preserve at that point —
  // spread it evenly so the ordering invariant still holds.
  if (cleaned[0] < MIN_RUNG) {
    const span = MAX_RUNG - MIN_RUNG;
    const step = span / Math.max(1, cleaned.length - 1);
    for (let i = 0; i < cleaned.length; i++) cleaned[i] = MIN_RUNG + i * step;
  }

  return cleaned.map((r) => Math.round(r * 1000) / 1000);
}

/** Install a new ladder. Input is normalized first — callers may pass raw
 *  config values. */
export function setLadder(next: readonly number[]): readonly number[] {
  ladder = normalizeLadder(next);
  return ladder;
}

/** Restore the built-in ladder. Used by tests and `/context tune --reset`. */
export function resetLadder(): void {
  ladder = DEFAULT_LADDER;
  maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS;
}

/** Absolute compaction ceiling in tokens. */
export function getMaxContextTokens(): number {
  return maxContextTokens;
}

/** Set the absolute ceiling. Values below MIN_MAX_CONTEXT_TOKENS are ignored —
 *  a tiny cap would compact away the working set every turn. 0 or negative
 *  disables the cap (ladder-only behaviour). */
export const MIN_MAX_CONTEXT_TOKENS = 8_000;
export function setMaxContextTokens(n: number): number {
  if (!Number.isFinite(n)) return maxContextTokens;
  maxContextTokens = n <= 0 ? Number.POSITIVE_INFINITY : Math.max(MIN_MAX_CONTEXT_TOKENS, Math.floor(n));
  return maxContextTokens;
}

/**
 * Token count at which compaction fires: the lower of the ladder rung for
 * this generation and the absolute ceiling. Both compaction strategies and
 * the context bar read this, so the engine and the display can't disagree.
 */
export function compactionThreshold(window: number, generation: number): number {
  return Math.min(Math.floor(window * thresholdRatioFor(generation)), getMaxContextTokens());
}

/**
 * Verbatim tail budget kept through a compaction pass. Window-relative as
 * before, but never more than MAX_RETENTION_OF_TRIGGER of the actual trigger
 * — otherwise a capped run would compact down to just under the cap and
 * re-fire on the next turn.
 */
export function retentionBudget(window: number): number {
  const trigger = compactionThreshold(window, 0);
  return Math.min(
    Math.floor(window * RETENTION_RATIO),
    Math.floor(trigger * MAX_RETENTION_OF_TRIGGER),
  );
}

/**
 * Trigger ratio for a given recap generation. Held at the last rung once the
 * ladder is exhausted — ROLLOVER_AT_GENERATION (compactor.ts) caps how many
 * in-place rounds happen before a full generational flush.
 */
export function thresholdRatioFor(generation: number): number {
  const l = getLadder();
  return l[Math.min(Math.max(0, generation), l.length - 1)];
}
