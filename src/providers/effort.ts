// ─────────────────────────────────────────────────────────────────────────────
// Reasoning effort — one vocabulary across providers.
//
// Thinking models expose a knob for how much chain-of-thought to spend before
// answering, but the ladders differ in length and a value off the end of one is
// a hard 400, not a silent clamp. DeepSeek answers an unknown rung with:
//
//   reasoning_effort: unknown variant `zzz`, expected one of `none`,
//   `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
//
// so whatever the user types can never be forwarded blind. Aura takes
// DeepSeek's seven-rung ladder as the canonical vocabulary — it is the longest
// one we've verified — and clamps down to what the target actually accepts.
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical ladder, ascending. `none` disables thinking outright. */
export const EFFORT_LEVELS = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
] as const;

export type EffortLevel = typeof EFFORT_LEVELS[number];

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/** Case/whitespace-tolerant parse for CLI args, `.aura.json`, and `:effort`. */
export function parseEffort(raw: unknown): EffortLevel | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  return isEffortLevel(v) ? v : undefined;
}

/**
 * Whether the target speaks the whole ladder.
 *
 * Verified live against api.deepseek.com on 2026-08-05: all seven rungs return
 * 200 on deepseek-v4-flash, and `none` measurably zeroes the reasoning output
 * (0 reasoning chars / 1 completion token, against 50 / 17 at the default).
 * Per DeepSeek's thinking-mode guide the flash model maps xhigh down to high
 * internally, so xhigh and high are the same spend there — max is the real
 * ceiling.
 *
 * Detection keys off the model id and endpoint rather than the display name:
 * the factory reaches this provider for a bare `deepseek-v4-flash` as well as
 * a `deepseek/`-prefixed id, and a custom `.aura.json` provider can point at
 * DeepSeek under any label it likes.
 */
export function supportsFullLadder(target: { model?: string; baseUrl?: string }): boolean {
  const m = (target.model ?? '').toLowerCase();
  const url = (target.baseUrl ?? '').toLowerCase();
  return m.startsWith('deepseek') || url.includes('api.deepseek.com');
}

/**
 * Everything else only reliably speaks the OpenAI trio, so the outer rungs
 * fold inward: `none`/`minimal` become the least thinking on offer and
 * `xhigh`/`max` the most. Folding beats dropping the parameter — a user who
 * asked for max on a three-rung provider wants that provider's ceiling, not
 * its default.
 */
const FOLD_TO_COMMON: Record<EffortLevel, EffortLevel> = {
  none: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

/** The rung to actually put on the wire for this target. */
export function clampEffort(
  level: EffortLevel,
  target: { model?: string; baseUrl?: string },
): EffortLevel {
  return supportsFullLadder(target) ? level : FOLD_TO_COMMON[level];
}

/** True when the requested rung had to be folded to reach the target. */
export function wasClamped(
  level: EffortLevel,
  target: { model?: string; baseUrl?: string },
): boolean {
  return clampEffort(level, target) !== level;
}
