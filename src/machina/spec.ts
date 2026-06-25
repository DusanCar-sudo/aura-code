/**
 * `:machina` — the Abstract Agent Machine (AAM).
 *
 * This module states a formal model of what `aura-code` *is*, independent of
 * which LLM happens to be plugged in, and then checks every structural claim
 * it makes against the real source tree at run time (see verify.ts). A spec
 * that asserts "the main loop is at loop.ts:127" and never re-checks that
 * line drifts silently as the code changes — this one refuses to.
 *
 * ── The model ──────────────────────────────────────────────────────────────
 * AAM is the 5-tuple  (S, P, O, δ, s0):
 *
 *   S   — state space. A state is the full conversation history plus loop
 *         counters: s = (history, turns, usage). Every run lives inside S.
 *   P   — primitives. The finite, fixed set of tool definitions the machine
 *         can invoke (read_file, run_command, edit, ...). P is finite and
 *         enumerable — this is NOT where unboundedness comes from.
 *   O   — the oracle. A function history -> {text, tool_calls, stop_reason}.
 *         The oracle is the ONLY part of the tuple that is swappable: it can
 *         be an LLM, a human, a rule table, or another AAM run recursively.
 *         Swapping the oracle does not change S, P, δ, or s0.
 *   δ   — the transition function. δ(s, o(s)) -> s'. Concretely: take the
 *         oracle's output, run it through the safety gate, execute any tool
 *         calls against P, fold the results back into history, and check
 *         halting conditions.
 *   s0  — the initial state: empty history + the user's task as the first
 *         message.
 *
 * ── Why this matters, precisely ────────────────────────────────────────────
 * Because δ can simulate a Turing machine's transition function (the oracle
 * can be made to emit "move tape head" tool calls and the primitives can
 * implement a tape as a file), AAM is Turing-complete *in principle*, for
 * an UNBOUNDED machine (infinite turns, infinite context). Turing-completeness
 * is the ceiling for computability — a quantum computer does not raise this
 * ceiling; it changes the *complexity* of specific problems (factoring,
 * search), not which problems are solvable at all. So "make the oracle
 * quantum" would be a speed upgrade to O, not a power upgrade to the tuple.
 *
 * Turing-completeness has a cost the spec must not hide: the Halting Problem
 * is undecidable for an unbounded AAM — there is no general procedure that
 * decides, for an arbitrary task, whether the loop ever stops. This is
 * exactly why real aura-code is NOT the unbounded machine: maxTurns and the
 * context compactor are deliberate, finite approximations that trade a
 * sliver of theoretical power for guaranteed termination. The unbounded
 * machine is elegant on paper and undecidable in practice; the bounded
 * machine is what you can actually run.
 */

export interface VerifiableClaim {
  id: string;
  /** Which part of the formal tuple this claim grounds. */
  component: 'S' | 'P' | 'O' | 'delta' | 's0' | 'limit';
  description: string;
  file: string;
  /** 1-indexed line number expected to contain `mustContain`. */
  line: number;
  /** A short, exact substring expected at that line — the actual verification check. */
  mustContain: string;
}

export const AAM_CLAIMS: VerifiableClaim[] = [
  {
    id: 'main-loop',
    component: 'delta',
    description: 'The main transition loop — one iteration is one application of δ.',
    file: 'src/agent/loop.ts',
    line: 127,
    mustContain: 'while (turns < maxTurns)',
  },
  {
    id: 'oracle-call',
    component: 'O',
    description: "The oracle invocation — O(history) -> stream of {text, tool_calls, stop_reason}.",
    file: 'src/agent/loop.ts',
    line: 142,
    mustContain: 'provider.stream(',
  },
  {
    id: 'safety-gate',
    component: 'delta',
    description: 'The safety gate inside δ — tool calls are checked against permissions before primitives execute.',
    file: 'src/agent/loop.ts',
    line: 224,
    mustContain: 'permissions.check(',
  },
  {
    id: 'compaction-threshold',
    component: 'limit',
    description: 'The state-space pressure-relief valve: history is compacted once it crosses 70% of the context window, keeping S finite in practice.',
    file: 'src/agent/compactor.ts',
    line: 4,
    mustContain: 'COMPACTION_THRESHOLD = 0.7',
  },
  {
    id: 'compaction-check',
    component: 'limit',
    description: 'The actual threshold comparison that triggers compaction.',
    file: 'src/agent/compactor.ts',
    line: 113,
    mustContain: 'if (totalTokens < threshold) return false;',
  },
  {
    id: 'max-turns',
    component: 'limit',
    description: 'T_max — the hard halting bound that makes the REAL machine decidable (terminates within 150 turns), unlike the unbounded theoretical AAM.',
    file: 'src/config/defaults.ts',
    line: 17,
    mustContain: 'maxTurns: 150',
  },
  {
    id: 'primitives',
    component: 'P',
    description: 'P — the finite, enumerable set of tool primitives the machine can invoke.',
    file: 'src/tools/index.ts',
    line: 32,
    mustContain: 'export const TOOL_DEFINITIONS',
  },
];

export const AAM_PREAMBLE =
  'Aura is not "an LLM with a loop around it." It is an Abstract Agent Machine: ' +
  'a 5-tuple (S, P, O, δ, s0) whose computational power comes from its structure ' +
  '— state space, primitives, transition function — not from which oracle (LLM, ' +
  'human, rule table) happens to be plugged into O. Swap the oracle and the ' +
  'machine is unchanged. This is what makes Aura provider-agnostic by ' +
  'construction, not by convention.';

export const AAM_LIMITS_NOTE =
  'The UNBOUNDED version of this machine (infinite turns, infinite context) is ' +
  'Turing-complete, which means the Halting Problem is undecidable for it: no ' +
  'general test can say whether an arbitrary task ever finishes. Real aura-code ' +
  'is deliberately NOT that machine — maxTurns and the context compactor below ' +
  'are the finite bounds that buy guaranteed termination at the cost of some ' +
  'theoretical power. A quantum oracle would not restore that power: ' +
  'Turing-completeness is already the ceiling for what is computable at all; ' +
  'quantum computation changes the cost of solving certain problems, not which ' +
  'problems are solvable.';
