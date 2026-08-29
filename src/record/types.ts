/**
 * `:catchthis` — demonstrate a job once, hand it back as a repeatable task.
 *
 * The shape of this is decided by one fact about Wayland: nothing will tell a
 * process where the mouse pointer currently is. evdev gives relative deltas,
 * and the compositor deliberately offers no global position API. So a recorded
 * click knows *that* it happened and not *where*.
 *
 * Hence the design. The screen capture already runs with the cursor drawn into
 * the frame (`cursor_mode: 2` in aura_screen.py), so each click is stored with
 * a screenshot that *shows* the pointer. Replay is then vision-guided: the
 * agent looks at the shot to understand what was clicked, and finds the
 * equivalent thing on screen now. That is also what makes row 2 of 20 work —
 * coordinates would already be wrong by the second row, and wrong silently,
 * which is the worst failure mode for something driving a real mouse.
 */

/** One event as the kernel reported it, before any interpretation. */
export interface RawEvent {
  /** Milliseconds since the recording started. */
  t: number;
  kind: 'key' | 'button' | 'scroll';
  /** evdev name: KEY_A, BTN_LEFT, REL_WHEEL. */
  code: string;
  /** 1 press, 0 release, 2 auto-repeat; for scroll, the signed notch count. */
  value: number;
}

export type Step =
  /** A run of printable characters typed in one go. */
  | { kind: 'type'; text: string; at: number }
  /** A modified keypress — Ctrl+C, Alt+Tab — or a bare named key like Enter. */
  | { kind: 'press'; label: string; at: number }
  /** A mouse click. `shot` names the screenshot that shows where. */
  | { kind: 'click'; button: 'left' | 'right' | 'middle'; count: number; at: number; shot?: string }
  | { kind: 'scroll'; direction: 'up' | 'down'; notches: number; at: number }
  /** A deliberate pause — the demonstrator waiting for something. */
  | { kind: 'wait'; ms: number; at: number };

export interface Recording {
  id: string;
  /** What the user called it, or the first thing they did. */
  title: string;
  createdAt: string;
  /** How long the demonstration took, in ms. */
  durationMs: number;
  steps: Step[];
  /** Screenshot files, in the state directory, referenced by `click.shot`. */
  shots: string[];
  /**
   * Everything typed during the recording, kept apart from the steps.
   *
   * The operator is shown this before the recording is stored, because a
   * kernel-level keyboard reader sees every window — including the one they
   * alt-tabbed to in the middle. Reviewing it is the point; hiding it inside a
   * step list nobody reads would not be a disclosure.
   */
  typedText: string[];
}
