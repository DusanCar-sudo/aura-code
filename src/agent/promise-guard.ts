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

/**
 * The other half of the failure the user actually reported: the model DOES
 * call tools ("i saw her working"), then signs off claiming a file was
 * produced or the tests pass — and neither happened. `looksPromissory` can't
 * catch this: it is past tense, and there were tool calls. So instead of
 * matching prose we check the claim against reality (see loop.ts):
 *
 *  - `claimedNewFiles` pulls the paths a reply says it created; the loop then
 *    stats them and pushes back on any that are not on disk.
 *  - `claimsVerification` flags "tests/build pass" wording; the loop pushes
 *    back when the run wrote code but ran nothing.
 */

/**
 * Some models (esp. open weights behind an OpenAI-compatible endpoint) emit
 * tool calls as plain text — the special tokens the function-calling API is
 * meant to consume — and the adapter passes them straight through as content.
 * The loop then sees text, zero parsed tool calls, and finish_reason "stop",
 * concludes the model is done, and returns success while nothing ran. This is
 * the reported "she says the file is produced and there is nothing" / "claims
 * finished but nothing was done" failure. Observed verbatim:
 *
 *   <|toolcallstart|>[runshell(command='echo "test" > /tmp/test.txt')]<|toolcall_end|>
 *
 * The `<|…|>` token family plus `<tool_call>…`, `[TOOL_CALLS]` and Llama's
 * `<|python_tag|>` essentially never appear in real prose, so matching them is
 * safe. The loop uses this to push back ("that ran nothing — use the tool
 * interface") instead of trusting the reply.
 */
export function looksLikeUnparsedToolCall(text: string): boolean {
  if (!text) return false;
  return (
    /<\|[^|]{0,60}tool[^|]{0,20}call[^|]{0,20}\|>/i.test(text)     // <|toolcallstart|>, <|tool▁call▁end|>, …
    || /<tool_call>|<\/tool_call>|<tool_call\b/i.test(text)        // <tool_call>{…}</tool_call>
    || /^\s*\[TOOL_CALLS?\]/im.test(text)                          // [TOOL_CALLS] […]
    || /<\|python_tag\|>/i.test(text)                             // Llama code-interpreter tag
    || /<\|tool▁calls▁begin\|>/i.test(text)                       // DeepSeek
  );
}

/** How many times a run may be corrected for emitting tool calls as text. Three:
 *  it is a mechanical mistake the model usually fixes once it is pointed out,
 *  and worth more retries than a content problem. */
export const MAX_UNPARSED_NUDGES = 3;

/** Sent when the reply carried a tool call as text that never executed. */
export const UNPARSED_TOOLCALL_CORRECTION =
  'Your reply contained a tool call written as text (e.g. "<|toolcall…|>" or "<tool_call>…"). ' +
  'Written that way it does NOT run — nothing happened. Do not put tool calls in the message body. ' +
  'Invoke the tool through the normal function/tool-calling interface so it actually executes, and ' +
  'retry the action now. If you cannot call tools, say so plainly instead of pretending you did.';

/** Creation verbs — deliberately not "updated/modified", which legitimately
 *  describe an edit_file to a file that already exists. */
const CREATE_VERB = String.raw`(?:created|added|wrote|written|generated|saved|produced|scaffolded|set up)`;

function looksLikePath(s: string): boolean {
  if (!s || /\s/.test(s) || s.length > 120) return false;
  if (/^[a-z]+:\/\//i.test(s)) return false;          // a URL, not a path
  return /\/|\.[A-Za-z0-9]{1,8}$/.test(s);            // has a dir separator or a file extension
}

/**
 * Paths a reply claims to have just created. Backtick-quoted paths near a
 * creation verb, plus "new file: <path>" / "file `<path>`" forms. Returned raw
 * (relative or absolute) for the caller to resolve against the repo root.
 */
export function claimedNewFiles(text: string): string[] {
  const t = text.slice(0, 4_000);
  const out = new Set<string>();
  const patterns = [
    new RegExp(String.raw`\b${CREATE_VERB}\b[^\n\`]{0,48}\`([^\`\n]{1,120})\``, 'gi'),
    new RegExp(String.raw`\bnew file\b[:\s]+\`?([^\s\`,)]{2,120})\`?`, 'gi'),
    new RegExp(String.raw`\bfile\s+\`([^\`\n]{1,120})\`[^\n]{0,32}\b(?:has been|was|is now)\b[^\n]{0,24}\b(?:created|added|written)\b`, 'gi'),
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const raw = m[1].trim().replace(/[.,;:)]+$/, '');
      if (looksLikePath(raw)) out.add(raw);
    }
  }
  return [...out];
}

/** True when a reply asserts that tests / the build / typecheck / lint passed
 *  or were run clean. Used only when the run changed code but executed nothing. */
export function claimsVerification(text: string): boolean {
  const t = text.slice(0, 1_500);
  return (
    /\b(?:tests?|test suite|unit tests|the build|typecheck|type-check|tsc|lint(?:er)?|compilation)\b[^.\n]{0,32}\b(?:pass(?:es|ed)?|succeed(?:s|ed)?|are green|is green|clean|successful|without (?:any )?errors?)\b/i.test(t)
    || /\ball (?:tests|checks|suites)\b[^.\n]{0,20}\b(?:pass|passing|green|succeed)\b/i.test(t)
    || /\b(?:verified|confirmed)\b[^.\n]{0,24}\b(?:tests?|build|typecheck|everything works|it works|it compiles)\b/i.test(t)
    || /\bI (?:ran|executed)\b[^.\n]{0,20}\b(?:the )?(?:tests?|test suite|build)\b/i.test(t)
  );
}

/** How many times a run may be pushed back on an ungrounded completion claim
 *  before it is returned as `success: false`. */
export const MAX_GROUND_NUDGES = 2;

/** The correction for a claimed-but-absent file. */
export function missingFilesCorrection(files: string[]): string {
  const list = files.map(f => `"${f}"`).join(', ');
  const it = files.length === 1 ? 'it' : 'them';
  return (
    `You said you created ${list}, but ${files.length === 1 ? 'it does' : 'they do'} not exist on disk, ` +
    `and you made no write_file call for ${it}. Nothing was produced. ` +
    `Create the file${files.length === 1 ? '' : 's'} now by calling write_file in this reply, with the full content. ` +
    `If you meant a file that already exists under a different path, say the real path — do not claim you wrote a new one.`
  );
}

/** The correction for "tests pass" with nothing run. */
export const UNRAN_VERIFICATION_CORRECTION =
  'You changed code this task and then said the tests/build pass, but you did not run them — ' +
  'so that claim is unverified. Run them now with run_shell (e.g. the project test or build command) ' +
  'and report the actual output. If you cannot run them here, say so plainly and do not claim they pass.';

/** Sent when a run is about to end having promised work and called nothing. */
export const PROMISE_CORRECTION =
  'You ended your turn by describing work you were about to do, but you did not call any tool, ' +
  'so nothing happened. Do not narrate or announce. Make the tool calls that perform the task ' +
  'right now in this reply — read what you need, then write the change with write_file or ' +
  'edit_file. If the task is already complete, say specifically what you verified and how. ' +
  'If you cannot proceed, say exactly what is blocking you.';
