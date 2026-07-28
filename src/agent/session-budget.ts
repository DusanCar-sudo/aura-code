/**
 * Session-level spend guard, shared across every runAgentLoop invocation that
 * belongs to one user-facing conversation.
 *
 * Why this exists: `maxTurns` is a *per-invocation* ceiling. A coder
 * conversation (see coder-conversation.ts) calls runAgentLoop once per user
 * message, carrying history forward each time, so the turn counter restarts at
 * 1 on every segment while the history — and therefore the per-call input cost
 * — keeps growing. Measured on a real session: turns ran to 80, then restarted
 * at 1/2/3 with the input payload already at 55k tokens per call. A 30-turn cap
 * on a three-segment conversation still permits 90 turns.
 *
 * Two ceilings, because turns are a poor proxy for cost:
 *
 *  - `maxTurns`     — cumulative model turns across the whole conversation.
 *  - `maxInputTokens` — cumulative input tokens **net of prompt-cache hits**.
 *    This is the meaningful one. Cost is driven by the resent history, which
 *    grows linearly per turn and therefore quadratically in total; a session
 *    can be well inside a turn budget and still be the expensive one. In the
 *    session that motivated this, cumulative input passed 1M at turn 50 and
 *    reached 2.22M by turn 85.
 *
 * Net-of-cache, not raw `prompt_tokens`, because cache hits are billed at a
 * fraction of the standard rate (GLM-5.2: $0.26 vs $1.40 per Mtok) and a
 * ceiling that ignores them would stop a cheap well-cached session and an
 * expensive cold one at the same point. The same session that reads as 2.22M
 * raw is ~222k billed at a 90% hit rate. Turns are the blunt backstop for
 * when caching doesn't save you; this tracks what is actually paid for.
 *
 * Whichever binds first stops the run. The budget is advisory to the caller,
 * not a hard abort: the loop finishes its current turn and returns normally,
 * so history is persisted and the session stays resumable.
 */

/** Cumulative billed input tokens before a conversation is a runaway.
 *  A backstop above the turn cap, not a routine limit: a 50-turn session that
 *  caches well bills a small fraction of this, while a cold one reaches it. */
export const DEFAULT_MAX_INPUT_TOKENS = 1_000_000;

/** Env override for the token ceiling, for the case the default is wrong for
 *  the work at hand (a large planned refactor that legitimately bills past 1M).
 *
 *    unset / empty  → DEFAULT_MAX_INPUT_TOKENS. Unchanged for anyone who has
 *                     not opted in; the guard is not something you can disable
 *                     by accident.
 *    0              → Infinity, i.e. no token ceiling. An explicit opt-out.
 *    positive N     → N billed input tokens.
 *
 *  A malformed value falls back to the default rather than to unlimited —
 *  failing open on a typo would remove the guard silently, which is the one
 *  outcome this must never have. */
export const SESSION_BUDGET_ENV = 'AURA_SESSION_BUDGET';

let warnedBadBudgetEnv = false;

export function maxInputTokensFromEnv(
  raw: string | undefined = process.env[SESSION_BUDGET_ENV],
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_MAX_INPUT_TOKENS;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    if (!warnedBadBudgetEnv) {
      warnedBadBudgetEnv = true;
      process.stderr.write(
        `${SESSION_BUDGET_ENV}="${trimmed}" is not a non-negative number — ` +
        `using the default ceiling of ${DEFAULT_MAX_INPUT_TOKENS.toLocaleString()}. ` +
        `Set 0 for no ceiling.\n`,
      );
    }
    return DEFAULT_MAX_INPUT_TOKENS;
  }
  return parsed === 0 ? Infinity : parsed;
}

/** Test seam: the bad-value warning fires once per process. */
export function resetBudgetEnvWarning(): void {
  warnedBadBudgetEnv = false;
}

export interface SessionBudgetLimits {
  /** Cumulative turns across all segments. Undefined = no turn ceiling. */
  maxTurns?: number;
  /** Cumulative input tokens net of prompt-cache hits. When omitted, falls
   *  back to AURA_SESSION_BUDGET and then to DEFAULT_MAX_INPUT_TOKENS; pass
   *  Infinity to disable. An explicit value always beats the env var, so a
   *  caller that has computed a ceiling keeps it. */
  maxInputTokens?: number;
}

export type BudgetStop =
  | { kind: 'turns'; used: number; limit: number }
  | { kind: 'tokens'; used: number; limit: number };

export function describeBudgetStop(stop: BudgetStop): string {
  return stop.kind === 'turns'
    ? `session turn budget exhausted (${stop.used}/${stop.limit} turns across this conversation)`
    : `session token budget exhausted (${stop.used.toLocaleString()}/${stop.limit.toLocaleString()} billed input tokens across this conversation)`;
}

export class SessionBudget {
  readonly maxTurns: number;
  readonly maxInputTokens: number;
  private turns = 0;
  private inputTokens = 0;

  constructor(limits: SessionBudgetLimits = {}) {
    this.maxTurns = limits.maxTurns ?? Infinity;
    this.maxInputTokens = limits.maxInputTokens ?? maxInputTokensFromEnv();
  }

  get turnsUsed(): number { return this.turns; }
  /** Cumulative input tokens actually billed (raw prompt minus cache hits). */
  get inputTokensUsed(): number { return this.inputTokens; }

  /** Turns still available, for sizing a segment's own cap. */
  get turnsRemaining(): number {
    return Math.max(0, this.maxTurns - this.turns);
  }

  recordTurn(): void { this.turns++; }

  /** Drop the accumulated totals, keeping the configured ceilings.
   *
   *  The budget bounds one *conversation*, but it lives on the REPL process,
   *  which outlives any single conversation. `:new` mints a fresh session id
   *  and empty history — the resent history that made the previous
   *  conversation expensive is gone, and the next call bills a cold prompt —
   *  so carrying its total forward charges the new conversation for spend it
   *  did not incur. Without this the ceiling is effectively per-process:
   *  once reached, every subsequent session starts already exhausted and the
   *  ":new to start fresh" remedy the exhaustion message offers does nothing. */
  reset(): void {
    this.turns = 0;
    this.inputTokens = 0;
  }

  /** Called once per provider call with that call's prompt size and how much
   *  of it the provider served from cache. Only the uncached remainder counts
   *  against the ceiling. `cached` is clamped so a provider over-reporting
   *  cache hits can never drive the total backwards. */
  recordCall(promptTokens: number, cachedTokens = 0): void {
    this.inputTokens += Math.max(0, promptTokens - Math.min(cachedTokens, promptTokens));
  }

  /** Non-null once either ceiling is reached. Checked before each turn. */
  exhausted(): BudgetStop | null {
    if (this.turns >= this.maxTurns) {
      return { kind: 'turns', used: this.turns, limit: this.maxTurns };
    }
    if (this.inputTokens >= this.maxInputTokens) {
      return { kind: 'tokens', used: this.inputTokens, limit: this.maxInputTokens };
    }
    return null;
  }
}
