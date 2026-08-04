// ─────────────────────────────────────────────────────────────────────────────
// Degenerate-repetition detection for a streaming response.
//
// Models — small/fast ones especially — sometimes collapse mid-reply and emit
// the same phrase until they hit their output cap. Observed with
// stepfun/step-3.5-flash asked to produce a large HTML page: it narrated
// "Writing the HTML structure... " several hundred times, burned the whole
// 16,384-token output allowance, came back stopReason 'limit', and the run ended
// having produced nothing. Nothing in the harness noticed: text chunks were
// appended and displayed no matter what they contained.
//
// This watches the stream's tail and reports the collapse as soon as it is
// unmistakable, so the caller can cut the reply off instead of paying for the
// rest of it. It looks for an exactly periodic tail, which is what a collapsed
// model produces; ordinary prose does not repeat a phrase verbatim dozens of
// times in a row.
// ─────────────────────────────────────────────────────────────────────────────

/** The repeated unit and how far it ran. */
export interface Repetition {
  /** The phrase being repeated (one period of the cycle). */
  unit: string;
  /** How many consecutive times it repeats at the end of the stream. */
  reps: number;
  /** Total characters the repeated run covers. */
  chars: number;
}

export interface RepetitionGuardOptions {
  /** Longest cycle to look for. Longer "cycles" are usually real content. */
  maxUnit?: number;
  /** Consecutive repeats required. */
  minReps?: number;
  /** …and the run must cover at least this many characters, so a handful of
   *  repeated short lines in legitimate output never trips it. */
  minRunChars?: number;
  /** Rescan after this much new text. Bounds the cost on a long reply. */
  scanEvery?: number;
}

/** How much of the tail is compared to find a candidate cycle length. */
const ANCHOR = 12;
/** Candidate cycle lengths tried per scan (nearest repeats of the anchor). */
const CANDIDATES = 4;

export interface RepetitionGuard {
  /** Feed the next chunk of streamed text. Returns the collapse once it is
   *  certain, and the same object on every later call. */
  push(text: string): Repetition | null;
  /** The collapse, if one was detected. */
  readonly tripped: Repetition | null;
}

/**
 * A cycle is found wherever the stream happened to stop, so the unit usually
 * starts mid-phrase — "re... Writing the HTML structu" for a loop a human would
 * describe as "Writing the HTML structure... ". Every rotation is an equally
 * valid period, so pick the one a person can read: the first that starts after
 * a sentence end or newline. This is presentation only; reps and chars are
 * unaffected.
 */
function rotateToBoundary(unit: string): string {
  if (unit.length < 4) return unit;
  const doubled = unit + unit;
  const m = /[.!?…]["')\]]?\s+|\n+/.exec(doubled);
  if (!m) return unit;
  const start = m.index + m[0].length;
  if (start === 0 || start >= unit.length) return unit;
  return doubled.slice(start, start + unit.length);
}

export function createRepetitionGuard(opts: RepetitionGuardOptions = {}): RepetitionGuard {
  // Escape hatch. The thresholds are set so ordinary output cannot reach them,
  // but a guard that cuts replies off is not something anyone should have to
  // wait for a release to switch off.
  if (process.env.AURA_REPETITION_GUARD === '0' || process.env.AURA_REPETITION_GUARD === 'false') {
    return { push: () => null, get tripped() { return null; } };
  }

  const maxUnit = opts.maxUnit ?? 600;
  const minReps = opts.minReps ?? 10;
  const minRunChars = opts.minRunChars ?? 1200;
  const scanEvery = opts.scanEvery ?? 400;
  // Enough tail to hold a whole qualifying run, and no more.
  const keep = Math.max(maxUnit * (minReps + 2), minRunChars * 2);

  let tail = '';
  let sinceScan = 0;
  let tripped: Repetition | null = null;

  /** Is the tail exactly periodic with period `p`, for long enough to count? */
  const periodAt = (p: number): Repetition | null => {
    if (p < 1 || p > maxUnit || p * minReps > tail.length) return null;
    const unit = tail.slice(tail.length - p);
    let reps = 1;
    let end = tail.length - p;
    while (end - p >= 0 && tail.startsWith(unit, end - p)) {
      reps++;
      end -= p;
    }
    if (reps < minReps || reps * p < minRunChars) return null;
    return { unit: rotateToBoundary(unit), reps, chars: reps * p };
  };

  return {
    get tripped() { return tripped; },

    push(text: string): Repetition | null {
      if (tripped) return tripped;
      if (!text) return null;

      tail = (tail + text).slice(-keep);
      sinceScan += text.length;
      if (sinceScan < scanEvery) return null;
      sinceScan = 0;
      if (tail.length < minRunChars) return null;

      // A collapsed tail ends with the cycle repeated, so the distance back to
      // a previous copy of the last few characters is a candidate period. Only
      // the nearest few are worth testing — that is where a real cycle sits.
      const anchor = tail.slice(-ANCHOR);
      let from = tail.length - ANCHOR - 1;
      for (let i = 0; i < CANDIDATES && from >= 0; i++) {
        const idx = tail.lastIndexOf(anchor, from);
        if (idx < 0) break;
        const hit = periodAt(tail.length - ANCHOR - idx);
        if (hit) {
          tripped = hit;
          return hit;
        }
        from = idx - 1;
      }
      return null;
    },
  };
}

/** One-line, log-safe description of a collapse. */
export function describeRepetition(r: Repetition): string {
  const unit = r.unit.replace(/\s+/g, ' ').trim();
  const shown = unit.length > 60 ? `${unit.slice(0, 57)}…` : unit;
  return `repeated "${shown}" ${r.reps}× (${r.chars.toLocaleString()} chars)`;
}
