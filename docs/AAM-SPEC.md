# Abstract Agent Machine — Formal Specification

**Version:** 0.8.0 (spec text re-verified against source 2026-07-07; §6 anchors below match live `src/` line numbers as of that date — expect drift after future edits to `loop.ts`/`compactor.ts`, since `:machina` checks the structural claims, not this document's line numbers)
**Status:** Draft  
**Author:** Aura (built by agents, for agents)

> *"An agent is not a program. A program is a fixed path through a state space.
> An agent is a machine that *chooses* the path."*

---

## Table of Contents

1. [Preamble](#1-preamble)
2. [Definition](#2-definition)
3. [Operational Semantics](#3-operational-semantics)
4. [Oracle Interface](#4-oracle-interface)
5. [Turing-Completeness](#5-turing-completeness)
6. [Implementation Mapping: Aura Code](#6-implementation-mapping-aura-code)
7. [Limits & Invariants](#7-limits--invariants)

---

## 1. Preamble

### 1.1 Motivation

Contemporary LLM-based coding agents (Claude Code, Cursor, Aura Code) share an
unstated common structure: a loop that **observes**, **reasons**, **acts**, and
**incorporates feedback**. This document formalises that structure as the
**Abstract Agent Machine (AAM)**: a mathematical model that is:

- **Implementation-agnostic** — the reasoning engine (the "oracle") is an
  interchangeable component, not part of the machine itself
- **Provably Turing-complete** — can simulate any Turing machine
- **Concretely realisable** — the Aura Code codebase is a faithful instance

### 1.2 Notation

| Symbol | Meaning |
|--------|---------|
| $\mathbb{S}$ | Set of all possible agent states |
| $\mathbb{P}$ | Set of primitive actions (tools) |
| $\mathbb{O}$ | Set of oracle outputs (reasoning + actions) |
| $s \in \mathbb{S}$ | A specific agent state |
| $\varepsilon$ | The empty/initial state |
| $\bot$ | The halting state |
| $\rightarrow$ | State transition |
| $\mathcal{M}_{\text{AAM}}$ | The Abstract Agent Machine |

---

## 2. Definition

### 2.1 The Machine

An **Abstract Agent Machine** $\mathcal{M}_{\text{AAM}}$ is a 5-tuple:

$$\mathcal{M}_{\text{AAM}} = (\mathbb{S}, \mathbb{P}, \mathbb{O}, \delta, s_0)$$

where:

- **$\mathbb{S}$** is a **set of states**, each state $s = (C, H, M, \Gamma)$:
  - $C$ — **context**: the environment snapshot (files, git log, directory tree)
  - $H$ — **history**: ordered sequence of past observations and actions
  - $M$ — **memory**: persistent key-value store (survives sessions)
  - $\Gamma$ — **goal**: the user's task, immutable for the duration of a run

- **$\mathbb{P}$** is a **finite set of primitives** (tools): each $p \in \mathbb{P}$
  has typed input $I_p$ and output $O_p$

- **$\mathbb{O}$** is the **oracle's output space**: a pair $(t, \bar{p})$ where
  $t$ is text (reasoning) and $\bar{p} \subseteq \mathbb{P} \times I$ is a
  (possibly empty) set of primitive invocations with their inputs

- **$\delta: \mathbb{S} \times \mathbb{O} \rightarrow \mathbb{S} \cup \{\bot\}$**
  is the **transition function**

- **$s_0 \in \mathbb{S}$** is the **initial state**

### 2.2 The Oracle

The **oracle** $\mathcal{O}$ is *not part of the machine*. It is an external
function:

$$\mathcal{O}: \mathbb{S} \rightarrow \mathbb{O}$$

that maps the current state to reasoning + chosen actions. The AAM *invokes*
$\mathcal{O}$ but does not constrain its implementation. It may be:

- A large language model (LLM)
- A human operator
- A rule-based expert system
- Another AAM (recursive composition)

**Invariant:** The AAM's correctness does not depend on the oracle being
"intelligent". The machine's computational power derives from its structure,
not from the oracle's quality.

### 2.3 State Representation

A state $s \in \mathbb{S}$ is:

```
s = {
  context: {
    root: Path,          // working directory
    name: String,        // project name
    language: String,    // detected language
    framework: String,   // detected framework
    readme: String,      // README (truncated)
    tree: String,        // directory tree
    config: String,      // package.json etc.
    recentCommits: String // git log
  },
  history: [
    { role: "user",       content: String },
    { role: "assistant",  content: String, toolCalls: [ToolCall] },
    { role: "tool_result", results: [ToolResult] }
  ],
  memory: { Key → Value },
  goal: String
}
```

### 2.4 Primitive Classification

| Category | Effect | Examples |
|----------|--------|----------|
| **Observe** | Read-only; no state mutation | `read_file`, `list_dir`, `search_code`, `git_status`, `web_fetch`, `web_search`, `memory (recall)` |
| **Mutate** | Changes filesystem or environment | `edit_file`, `write_file`, `run_shell` |
| **Validate** | Tests state against specification | `run_tests` |
| **Communicate** | Outputs to user or external systems | `notify`, `telegram`, `email`, `calendar` |
| **Delegate** | Spawns a sub-agent | `spawn_task` |

---

## 3. Operational Semantics

### 3.1 The Loop

The AAM executes as a **state-transition loop**:

```
function run(s0, O):
  s ← s0
  while s ≠ ⊥:
    o ← O(s)                // consult oracle
    s ← δ(s, o)             // apply transition
  return s
```

### 3.2 Transition Function δ

The transition function $\delta(s, o)$ where $o = (t, \bar{p})$:

```
δ(s, (t, [])):
  // oracle produced text only, no tools
  if stop_reason = 'done':
    return ⊥              // halt
  s.history.push({ role: "assistant", content: t })
  return s

δ(s, (t, [(p1, i1), ...])):
  // oracle produced tools
  results ← []
  for (p, i) in (p1, i1), ...:
    result ← execute(p, i)
    results.push({ p, result })
  s.history.push({ role: "assistant", content: t, toolCalls: [...] })
  s.history.push({ role: "tool_result", results })
  return s
```

### 3.3 Halting Conditions

The machine halts ($s \rightarrow \bot$) when:

1. **Goal achieved** — oracle signals `stopReason = 'done'`
2. **Token limit** — oracle signals `stopReason = 'limit'`
3. **Max turns** — configurable bound $T_{\max}$ is reached
4. **Error** — the oracle fails (provider error, network error)

### 3.4 Context Compaction

When state size exceeds threshold $\tau = 0.7 \times W$ (where $W$ is
the oracle's context window), the machine **compacts** history:

```
compact(s):
  keep_first ← 1
  keep_last ← find_last_user_turn(s.history, 1)
  middle ← s.history[1:keep_last]
  summary ← summarise(middle)
  s.history ← [s.history[0], summary, s.history[keep_last:]]
```

Lossy compression: goal and most recent interaction are preserved verbatim;
older turns collapse into a single descriptive message.

---

## 4. Oracle Interface

### 4.1 Contract

The oracle $\mathcal{O}$ must implement:

```
O(s: State) → { text: String, toolCalls: [ToolCall], stopReason: String }
```

where:
- `text`: free-form reasoning (may be empty)
- `toolCalls`: zero or more primitive invocations
- `stopReason`: `"done"` | `"tools"` | `"limit"`

### 4.2 Oracle-Agnostic Design

The machine treats the oracle as a **black box**. Two oracles are
indistinguishable if they produce identical $(t, \bar{p})$ pairs for identical
states:

```
∀s ∈ 𝕊: O₁(s) = O₂(s) ⇒ M_AAM with O₁ ≡ M_AAM with O₂
```

### 4.3 Recursive Composition

An AAM may serve as oracle for another AAM:

```
Oₐ(s) = run_M_AAM(s₀, O_b)
```

This is **recursive delegation**. Depth is bounded only by practical
constraints (time, tokens), not by the model.

### 4.4 Primitive Execution Contract

Every primitive $p \in \mathbb{P}$ obeys:

```
execute(p, input) → (output, isError)
```

where:
- `output: String` — the result (may be empty)
- `isError: Boolean` — true if the primitive failed

**Errors are data, not exceptions.** An error result is appended to history
like any other observation, allowing the oracle to recover.

### 4.5 Safety Layer

Before execution, every primitive passes through a permission gate:

```
check(p, input) → { allowed, needsConfirm, reason }
```

If `allowed = false`, the primitive is **blocked** and a synthetic error
result is returned. If `needsConfirm = true`, the machine suspends and
awaits user approval.

---

## 5. Turing-Completeness

### 5.1 Claim

**Theorem:** The Abstract Agent Machine $\mathcal{M}_{\text{AAM}}$ is
Turing-complete.

### 5.2 Proof by Simulation of a Turing Machine

We show that $\mathcal{M}_{\text{AAM}}$ can simulate an arbitrary Turing machine
$\mathcal{M}_{\text{TM}} = (Q, \Sigma, \Gamma, \delta_{\text{TM}}, q_0, q_{\text{accept}})$.

**Construction:**

1. **Tape representation:** Store tape as file `_tape.txt` with symbols at
   each position, file `_head.txt` with head position and current state.

2. **State mapping:** Map each TM state $q \in Q$ to an AAM state where:
   - $s.\text{goal}$ encodes "simulate TM step"
   - $s.\text{context}$ includes tape files
   - $s.\text{memory}$ stores transition table

3. **Transition simulation:** Primitive `simulate_step`:
   - Reads current symbol under head
   - Looks up $\delta_{\text{TM}}(q, \text{symbol})$
   - Writes new symbol
   - Moves head left/right
   - Updates state
   - If $q = q_{\text{accept}}$, signal completion

4. **Loop:** Oracle repeatedly invokes `simulate_step` until halt.

**Reduction:** For every TM $\mathcal{M}_{\text{TM}}$, there exists an AAM
configuration $(\mathbb{S}', \mathbb{P}', \mathcal{O}')$ whose execution is
isomorphic to the TM's.

### 5.3 Corollary

Since $\mathcal{M}_{\text{AAM}}$ is Turing-complete, it inherits all
limitations of the Turing machine model:

- The **Halting Problem** is undecidable for AAMs
- There exist valid programs that never terminate
- The AAM cannot determine whether a given goal is achievable

### 5.4 Non-Triviality

Turing-completeness is a low bar (a single `run_shell` primitive with bash
makes the machine Turing-complete). The **non-trivial** claim is that the
*oracle-guided loop itself* is Turing-complete, following from:

1. **Unbounded memory** — filesystem storage
2. **Conditional branching** — `read_file` observation + `edit_file` mutation
3. **Arbitrary iteration** — the outer `while` loop

---

## 6. Implementation Mapping: Aura Code

The Aura Code codebase (`src/`) is a concrete instance of $\mathcal{M}_{\text{AAM}}$.

### 6.1 State: ProjectContext + HistoryMessage[]

| AAM | Aura Code | File:Line |
|-----|-----------|-----------|
| Context $C$ | `ProjectContext` interface | `src/agent/context.ts:6-16` |
| History $H$ | `HistoryMessage[]` type | `src/providers/types.ts:44-47` |
| Memory $M$ | `memory` tool → `~/.aura/memory.json` | `src/tools/memory.ts` |
| Goal $\Gamma$ | `task` parameter | `src/agent/loop.ts:17` |

### 6.2 Primitives: TOOL_DEFINITIONS

| AAM | Aura Code | File:Line |
|-----|-----------|-----------|
| Primitive set $\mathbb{P}$ | `TOOL_DEFINITIONS[]` | `src/tools/index.ts:29-154` |
| Dispatcher | `executeTool()` | `src/tools/index.ts:160-195` |
| Safety gate | `permissions.check()` | `src/agent/loop.ts:349` |

### 6.3 Oracle: LLMProvider

| AAM | Aura Code | File:Line |
|-----|-----------|-----------|
| Oracle interface | `LLMProvider` interface | `src/providers/types.ts:75-98` |
| Stream contract | `AsyncGenerator<StreamChunk>` | `src/providers/types.ts:64-69` |
| Concrete oracles | Anthropic / OpenAI / Google / DeepSeek | `src/providers/*.ts` |

### 6.4 Transition δ: runLoopBody()

| AAM | Aura Code | File:Line |
|-----|-----------|-----------|
| Main loop | `while (true)`, budget checked each iteration | `src/agent/loop.ts:172` |
| Oracle call | `provider.stream(...)` | `src/agent/loop.ts:235` |
| Tool exec | `executeTool(...)` call site | `src/agent/loop.ts:386` |
| Halt: done | `stopReason === 'done'` | `src/agent/loop.ts:305` |
| Halt: limit | `stopReason === 'limit'` | `src/agent/loop.ts:316` |
| Halt: max | `turns >= maxTurns` (widens once via `profile.widenTo` before halting) | `src/agent/loop.ts:173` |

### 6.5 Compaction: compactHistory()

Compaction is no longer a single fixed threshold — it's an escalating
generational ladder plus a token-budget retention window.

| AAM | Aura Code | File:Line |
|-----|-----------|-----------|
| Threshold ladder $\tau_g$ | `LADDER = [0.55, 0.70, 0.85]`, indexed by recap generation | `src/agent/compactor.ts:13` |
| Threshold check | `if (totalTokens < threshold) return false;` | `src/agent/compactor.ts:227` |
| Trigger | `compactHistory()` call | `src/agent/loop.ts:217` |
| Lossy merge | `summariseMessage()` | `src/agent/compactor.ts:178-190` |
| Retention budget | `RETENTION_RATIO = 0.40` of context window, walked backward from the tail | `src/agent/compactor.ts:17, 234-241` |
| Turn-boundary snap | Snap `keepFrom` to the nearest user turn within 6 messages | `src/agent/compactor.ts:246-253` |
| Fallback (no nearby user turn) | `FALLBACK_KEEP = 3` most recent messages, walked forward past any leading `tool_result` | `src/agent/compactor.ts:20, 254-261` |

### 6.6 State Machine Diagram

```
                    ┌─────────────────────────────────┐
                    │                                 │
                    v                                 │
    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
    │  START   │→│ OBSERVE  │→│ REASON   │→│  ACT     │
    │  (s₀)    │ │ (context)│ │ (oracle) │ │ (tools)  │
    └──────────┘ └──────────┘ └──────────┘ └──────────┘
         │                                            │
         │  if done / limit / error / maxTurns        │
         └────────────────────────────────────────────┘
                                │
                                v
                          ┌──────────┐
                          │   HALT   │
                          │   (⊥)    │
                          └──────────┘
```

---

## 7. Limits & Invariants

### 7.1 Fundamental Limits

| Limit | Source | Bound |
|-------|--------|-------|
| Context window | Oracle's max input size | 8K–2M tokens (model-dependent) |
| Execution depth | $T_{\max}$ config (`src/config/defaults.ts:10`) | default: 150, sized per task shape by the loop profile; widens once if the ceiling is hit mid-progress |
| Primitive set | Source at compile time | ~25 primitives |
| Tool call inputs | MCP constraints | ~1MB per call (practical) |

### 7.2 Invariants

Throughout execution, the following always hold:

1. **History monotonicity:** History only grows or is lossy-compacted, never
   deleted. The original goal is always at `history[0]`.

2. **Oracle purity:** The oracle never mutates state directly. It produces
   only reasoning text and tool call requests. All mutation occurs through
   primitives.

3. **Safety precedence:** The permission gate is evaluated before every
   primitive execution. A blocked primitive is reported as an error, not
   silently skipped.

4. **Deterministic primitive execution:** For identical inputs, a primitive
   always produces the same output (modulo side effects like timeouts or
   network failures).

---

*This specification is itself a product of an Abstract Agent Machine.*
