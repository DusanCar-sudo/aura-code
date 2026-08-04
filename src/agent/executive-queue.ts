/**
 * Executive queue — a bounded record of recent state-altering tool calls.
 *
 * When history is compacted, the model loses the verbatim record of what it
 * already executed; this queue's digest is injected into the compaction recap
 * so the model never repeats a write/edit/shell command it already ran.
 * Deliberately bounded (not an exhaustive ledger): only the most recent
 * mutations matter for "don't repeat yourself", and a cap keeps the recap
 * payload and state complexity flat.
 */

/** Tools that can change the working tree — the checkpoint trigger set. */
export const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'run_shell']);

export const EXECUTIVE_QUEUE_MAX = 20;

export interface ExecutiveEntry {
  name: string;
  summary: string;
  turn: number;
}

/** One-line summary of a call, mirroring how confirmations render them. */
function summarise(name: string, input: Record<string, unknown>): string {
  if (name === 'run_shell') {
    const cmd = String(input.command ?? '');
    return cmd.length > 100 ? `${cmd.slice(0, 100)}…` : cmd;
  }
  return String(input.path ?? input.file_path ?? '(unknown target)');
}

export class ExecutiveQueue {
  private entries: ExecutiveEntry[] = [];

  /** Record a call if it's state-altering; evicts the oldest past the cap. */
  push(name: string, input: Record<string, unknown>, turn: number): void {
    if (!MUTATING_TOOLS.has(name)) return;
    this.entries.push({ name, summary: summarise(name, input), turn });
    if (this.entries.length > EXECUTIVE_QUEUE_MAX) this.entries.shift();
  }

  get size(): number {
    return this.entries.length;
  }

  /** Digest for the compaction recap; newest last. Empty string when empty. */
  digest(): string {
    if (this.entries.length === 0) return '';
    const lines = this.entries.map(e =>
      e.name === 'run_shell' ? `run_shell: ${e.summary}` : `${e.name} ${e.summary}`,
    );
    return [
      'Recent state-altering actions already executed (do not repeat):',
      ...lines,
    ].join('\n');
  }
}
