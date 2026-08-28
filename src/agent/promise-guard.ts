/**
 * Detects a reply that *promises* work instead of doing it.
 *
 * The loop returns `success: true` for any turn that stops with `done`, which
 * is right when the model has finished — and wrong when it has announced an
 * intention and called nothing. Observed verbatim, each ending the run at
 * "1 turn · 0 tool call":
 *
 *   "Adding your 7 feature cards now — one quick edit."
 *   "Building your 7 feature cards now."
 *   "Checking if your Aura Pulse site is already live — pulling the repo now."
 *
 * The user answered "make it now" and then "finish fast", and got another
 * promise each time. The system prompt already forbids this ("never respond
 * with prose alone"; "you must eventually call write_file or edit_file"), so
 * the gap is not instruction, it is enforcement.
 *
 * This is deliberately a *narrow* predicate rather than "no tool calls means
 * failure". Plenty of legitimate replies end a run with prose and no tools —
 * answering a question, reporting that nothing needed changing, declining. The
 * distinguishing feature of the failure is future tense about work the model
 * was asked to do now, so that is what is matched, and the caller additionally
 * requires that the whole run made no tool calls at all.
 */

/** Verbs that, in the present participle, describe doing the task itself.
 *  "Adding …", "Pulling …". Verbs of *reporting* (explaining, summarising)
 *  are excluded: those describe the reply, not deferred work. */
const ACTION_GERUND =
  /^\s*(?:ok(?:ay)?[,.]?\s+|sure[,.]?\s+|right[,.]?\s+)?(adding|building|creating|writing|updating|fixing|checking|pulling|making|implementing|installing|setting up|wiring|adjusting|refactoring|removing|deleting|renaming|generating|running|applying|patching|configuring|deploying|publishing|starting|beginning)\b/i;

/** First-person commitments to act next. */
const FUTURE_INTENT =
  /\b(?:i'?ll|i will|i'?m going to|i am going to|let me|about to|will now|going to now|one moment|hold on|give me a (?:sec|second|moment))\b/i;

/** Trailing "… now." / "… right away." — the tell that pairs with both. */
const IMMINENT_TAIL = /\b(?:now|right away|straight away|in a moment|shortly)\s*[.!…]*\s*$/i;

/**
 * True when `text` reads as a promise of imminent work rather than a report of
 * finished work. Exported for tests: the boundary between "promised" and
 * "answered" is the whole contract, and it is not obvious from the regexes.
 */
export function looksPromissory(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  // A long reply is doing something — answering, explaining, summarising.
  // Promises are short; requiring brevity keeps essays out of the guard.
  if (t.length > 600) return false;

  // Past tense about the work is a report, not a promise, and can otherwise
  // collide with the gerund list ("Updated the config. Checking it now" is
  // still work done). Look only at the opening clause for the past-tense tell.
  const opening = t.slice(0, 120);
  if (/\b(?:added|built|created|wrote|updated|fixed|removed|deleted|renamed|applied|patched|ran|deployed|published|verified|confirmed)\b/i.test(opening)) {
    return false;
  }

  // A question back to the user is a legitimate stop.
  if (t.endsWith('?')) return false;

  return FUTURE_INTENT.test(t) || ACTION_GERUND.test(t) || IMMINENT_TAIL.test(t);
}

/** How many times one run may be told to stop narrating and act. Two: the
 *  first correction usually lands, and a model that has promised three times
 *  is not going to be argued into acting by a fourth message. */
export const MAX_PROMISE_NUDGES = 2;

/** Sent when a run is about to end having promised work and called nothing. */
export const PROMISE_CORRECTION =
  'You ended your turn by describing work you were about to do, but you did not call any tool, ' +
  'so nothing happened. Do not narrate or announce. Make the tool calls that perform the task ' +
  'right now in this reply — read what you need, then write the change with write_file or ' +
  'edit_file. If the task is already complete, say specifically what you verified and how. ' +
  'If you cannot proceed, say exactly what is blocking you.';
