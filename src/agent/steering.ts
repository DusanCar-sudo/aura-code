/**
 * Mid-run steering — messages typed while the agent loop is already working.
 *
 * The TUI never stops reading stdin during a task (see cli/tui.ts: startInput
 * stays on for the whole run), so a line can land at any point in a turn. Before
 * this existed the REPL had exactly two answers for such a line: `:stop`, which
 * throws the run away, or falling through to processLine, which starts a second
 * concurrent runAgentLoop against the same history. Neither is what someone
 * means when they think of one more thing halfway through.
 *
 * So: park the line here, and let the loop pick it up at its next turn
 * boundary. The run keeps its history, its tool results and its plan — it just
 * learns one more thing before deciding what to do next. Injection happens
 * between turns rather than mid-turn because that is the only point where
 * history is in a shape a provider will accept; a message shoved in while tool
 * calls are outstanding would leave tool_use blocks without their results.
 */

export interface SteeringInbox {
  /** Park a line typed mid-run. Empty/blank input is ignored. */
  post(text: string): void;
  /** Take everything parked, clearing the inbox. Empty array when nothing waits. */
  drain(): string[];
  /** How many messages are waiting — for status lines and tests. */
  readonly pending: number;
}

export function createSteeringInbox(): SteeringInbox {
  const queue: string[] = [];
  return {
    post(text: string): void {
      const trimmed = text.trim();
      if (trimmed) queue.push(trimmed);
    },
    drain(): string[] {
      return queue.splice(0, queue.length);
    },
    get pending(): number {
      return queue.length;
    },
  };
}

/**
 * Frame steered messages as a user turn the model reads as an amendment, not a
 * new task. The wording matters: without "keep going", models routinely treat a
 * fresh user message as a restart signal and re-plan from scratch, discarding
 * the work the run has already done.
 */
export function formatSteering(messages: string[]): string {
  const body = messages.length === 1
    ? messages[0]
    : messages.map(m => `- ${m}`).join('\n');
  return [
    '[The user sent this while you were working. It amends the task you are '
      + 'already on — fold it into what you are doing, adjust your plan if it '
      + 'changes anything, and keep going. Do not restart and do not re-do '
      + 'finished work.]',
    '',
    body,
  ].join('\n');
}
