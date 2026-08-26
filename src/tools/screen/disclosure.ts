/**
 * Consent and gating for computer use.
 *
 * Computer use is not another tool with a bigger blast radius — it changes what
 * leaving Aura running *means*. Two properties are worth stating plainly to the
 * person who turns it on:
 *
 *   1. A screenshot is the whole screen. Everything visible goes to the model
 *      provider: mail, chat, tickets, a password manager left open, a bank tab.
 *      Not the project directory — the desktop. Verified while building this:
 *      the first capture taken on a developer machine carried their inbox,
 *      Slack, and browser tabs into an agent's context.
 *   2. The agent drives the real pointer and keyboard. There is no sandbox, and
 *      a misgrounded click lands on whatever is actually under those
 *      coordinates.
 *
 * Neither is a reason to withhold the feature; both are reasons the person
 * enabling it should be told once, in those words, rather than discovering it
 * from a screenshot. So this module is a disclosure, not a restriction.
 *
 * The gate is deliberately independent of PermissionSystem's level. `auto`
 * approves every tool that is not run_shell or mcp connect, and the
 * dangerous-pattern blocklist is regex over shell strings — it cannot inspect a
 * click at (x, y) even in principle. So "the user runs in auto" must never be
 * what enables screen capture and input injection.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Env var that must be set to 1/true, in addition to the CLI flag. */
export const COMPUTER_USE_ENV = 'AURA_COMPUTER_USE';

/** Shown once per machine, before the first capture. */
export const COMPUTER_USE_DISCLOSURE = [
  '',
  '  Computer use — read this once before enabling it.',
  '',
  '  Screenshots are of your whole screen, not this project. Every capture is',
  '  sent to your model provider, including whatever happens to be visible:',
  '  email, chat, open documents, a password manager, a banking tab. Close or',
  '  minimise anything you would not paste into a chat window.',
  '',
  '  The agent moves your real pointer and types on your real keyboard. There',
  '  is no sandbox. A misgrounded click lands on whatever is under those',
  '  coordinates, in whatever application owns them.',
  '',
  '  Captures may be retained by the provider under their data policy, which',
  '  Aura does not control.',
  '',
  '  Stop a run with :stop or Ctrl+C. Turn this off again with :compoff, which',
  '  also releases the virtual input device and the screen-capture session.',
  `  It stays off at startup unless ${COMPUTER_USE_ENV}=1 is set with --computer.`,
  '',
].join('\n');

/** Where the acknowledgement is recorded — beside the global config rather
 *  than inside it, so a config rewrite by the setup wizard cannot silently
 *  clear a consent decision. */
export function acknowledgementPath(): string {
  return path.join(process.env.AURA_HOME ?? path.join(os.homedir(), '.aura'), 'computer-use-ack.json');
}

/** True when this machine has seen and accepted the disclosure. */
export function isAcknowledged(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(acknowledgementPath(), 'utf8')) as { accepted?: unknown };
    return raw.accepted === true;
  } catch {
    return false;
  }
}

/** Record acceptance. Best-effort: an unwritable home must not block the run,
 *  it just means the disclosure is shown again next time — the safe direction. */
export function acknowledge(): void {
  try {
    const p = acknowledgementPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ accepted: true, at: new Date().toISOString() }, null, 2));
  } catch { /* shown again next time */ }
}

export interface GateResult {
  allowed: boolean;
  /** Why not, phrased for the model — it is the one that sees this. */
  reason?: string;
  /** True when the caller should print the disclosure and ask for consent. */
  needsDisclosure?: boolean;
}

/**
 * Decide whether the computer tool may run at all.
 *
 * `flagEnabled` is the explicit CLI opt-in (--computer). Both it and the env
 * var are required: either alone is too easy to acquire by accident — an env
 * var exported once in a shell profile, or a flag copied from a forum post —
 * and this is the one tool where "enabled without meaning to" is the whole
 * risk. The permission level is not consulted, by design (see module comment).
 */
export function checkComputerUseGate(flagEnabled: boolean, env = process.env): GateResult {
  const raw = (env[COMPUTER_USE_ENV] ?? '').trim().toLowerCase();
  const envEnabled = raw === '1' || raw === 'true' || raw === 'yes';

  // Every refusal below names :compon. It used to say "restart with that
  // flag", which was both the slowest fix and a lossy one — the user threw
  // away the conversation to change a setting. The model is the one reading
  // this, and it relays it to the user, so the sentence it relays should be
  // the one that actually works from where they are sitting.
  const ENABLE_HINT = 'Do not retry. Tell the user to type :compon — that shows the '
    + 'disclosure, asks them to accept it, and turns computer use on in this session '
    + `without restarting. (Equivalent at startup: the --computer flag with ${COMPUTER_USE_ENV}=1.)`;

  if (!flagEnabled && !envEnabled) {
    return { allowed: false, reason: `Computer use is off. ${ENABLE_HINT}` };
  }
  if (!flagEnabled) {
    return {
      allowed: false,
      reason: `${COMPUTER_USE_ENV} is set but computer use is not enabled in this session. ${ENABLE_HINT}`,
    };
  }
  if (!envEnabled) {
    return {
      allowed: false,
      reason: `Computer use was enabled at startup but ${COMPUTER_USE_ENV} is not set to 1. ${ENABLE_HINT}`,
    };
  }
  if (!isAcknowledged()) {
    return {
      allowed: false,
      needsDisclosure: true,
      reason: 'Computer use has not been acknowledged on this machine yet. '
        + 'Do not retry — the user must accept the disclosure first, which :compon prompts for.',
    };
  }
  return { allowed: true };
}
