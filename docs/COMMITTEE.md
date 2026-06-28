# Committee Layer — Optional On-Demand Memory Validation

> A staging buffer between raw experience and permanent knowledge, gated
> by majority vote from a small local model. Triggered on-demand, same
> pattern as `:dream` — entirely optional, zero cost when never run.

## Why this exists

Baby Ruby (`src/mining/extract.ts`) and Papa Ruby (`src/mining/refine.ts`)
both run **on-demand** — you trigger `:mine`, they process whatever episodes
exist. Dream reconciliation (`src/dream/reconcile.ts`) runs after `:dream`,
gated at ≥3 dreams.

The Committee layer follows the exact same pattern: a new `:committee`
command, triggered by the user at a natural break point (end of a work
session, after a research pass, after auditing a large codebase) — same
shape as `:dream`, not a background process. This was a deliberate revision
from an earlier draft of this spec that proposed a continuous 15-minute
polling daemon; the daemon added a process-lifecycle problem (start/stop/
crash-recovery, idle resource cost on one-time projects) to solve a problem
that doesn't actually need continuous coverage — the goal is a clean
checkpoint at a moment the user chooses, not real-time ingestion.

This is the answer to the "memory pollution" risk flagged in review: instead
of one model's judgment deciding what's worth keeping (Papa Ruby today), a
**committee of three votes from the same small model** filters candidates
before they're even considered for the permanent knowledge graph.

## Hard requirement: this is modular, not a dependency

This is the single most important constraint on this design. The committee
layer:

- Is a **command the user explicitly runs** (`:committee`), exactly like
  `:dream`. It is never auto-triggered by any other command.
- If never run, **nothing else changes**. Baby Ruby, Papa Ruby, dream
  reconciliation, `:council`, everything works exactly as it does today —
  none of them read from or depend on the committee's output.
- Writes to its **own directory** (`committee/` or similar), never a
  location any other subsystem's read path touches.
- Requires Ollama (local model) to run at all. A user with no spare
  hardware, or who works on a one-time project, simply never runs the
  command — Aura's core experience is unaffected, and there is zero
  idle cost since nothing runs unless explicitly invoked.

If at any point a design decision would make the committee layer load-bearing
for some other feature, that's a violation of this requirement and the
design needs to change, not the requirement.

## Architecture

```
episodes (existing, unchanged)
       |
       v
:committee  (NEW command — user-triggered, same pattern as :dream)
  - processes episodes since the last :committee run
  - for each candidate concept (likely reusing mineExperience()):
      - ask the SAME small local model 3 times (3 independent calls,
        not 3 different models) whether this candidate is real signal
      - if 2-of-3 or 3-of-3 agree "keep" -> write to temp layer
      - otherwise -> discard (not written anywhere)
       |
       v
Temp Layer (NEW — committee/staging/*.jsonl, dated, append-only)
       |
       v
  (future: promotion step into the permanent knowledge graph —
   NOT specced here; this doc covers ingestion + committee gate only)
```

Natural usage moments: end of a work session (alongside `:dream`), after a
multi-stage research pass, after auditing a large/unfamiliar codebase —
any point where the user wants a clean, committee-filtered checkpoint of
what was learned. A one-time, throwaway project never needs to run it at
all, at zero cost.

## Why "same model, three times" — not three different models

Locked decision from design discussion:

- Three votes from the same model is a filter against **that model's own
  inconsistency**, not an attempt at diverse perspectives. Small models
  sometimes flip on borderline judgments between calls; requiring 2-of-3
  agreement catches that noise cheaply.
- Cost: 3x calls to one small local model is cheap (Ollama, no API cost,
  no rate limits to manage).
- Accepted tradeoff: occasionally a lower-value-but-still-clean memory gets
  through. That's fine — clean-but-modest beats polluted. The committee's
  job is precision (don't let garbage through), not recall (don't worry
  about missing some good candidates — Papa Ruby and dream reconciliation
  still run independently and will likely catch real patterns anyway).

## Data source: episodes only

Locked decision: `:committee` reads `episodes/` — the same source Baby Ruby
already reads. It does **not** watch live terminal output, file changes, or
in-progress conversation. This keeps a single clean boundary: episodes are
the one source of raw truth for every downstream system (Baby Ruby, Papa
Ruby, the committee command). No new data source, no new complexity at the
ingestion boundary.

Practical effect: `:committee` is a *stricter, vote-gated* sibling to
`:mine` — same input, same candidate-generation approach (likely reusing
`mineExperience()` directly), but every candidate must clear 2-of-3 votes
before it's written anywhere, rather than going straight to Papa Ruby's
single-pass judgment.

## Edge thickness: "frequently useful," not "frequently mentioned"

Locked decision: a memory's edge thickness in the eventual knowledge graph
should reflect **usefulness**, not raw mention count. Concretely:

```
usefulness_ratio = episodes_where_concept_appears_AND_reviewerApproved=true
                   / total_episodes_where_concept_appears
```

A concept is "frequently useful" if `usefulness_ratio >= 0.70`, with a
minimum occurrence floor (e.g. ≥5 occurrences) so a single 1-for-1 match
doesn't register as 100% confidence.

This is directly computable from existing `Episode.reviewerApproved` data —
no new tracking field needed. It answers a different question than Baby
Ruby's confidence (`cluster size / total episodes`, which measures
*frequency*) — this measures *correlation with success*, which is a
stronger signal for "this belief is worth weighting heavily."

## Open questions for implementation (next session, not tonight)

1. **What exactly is a "candidate memory unit"?** Is the committee voting
   on Baby-Ruby-style concepts (clusters), or on raw single-episode claims
   extracted directly? Leaning toward: reuse Baby Ruby's clustering as the
   candidate-generation step directly — `:committee` calls `mineExperience()`
   internally, then runs committee voting on each resulting concept, rather
   than inventing a separate candidate-extraction method.

2. **What happens to the temp layer over time?** This doc deliberately stops
   at "candidate passes committee -> written to temp layer." The promotion
   step (temp layer -> permanent knowledge graph) is NOT specced here. Before
   building this, decide: does promotion happen automatically the next time
   `:committee` runs and finds the same concept again, or does it require
   another explicit step (maybe folded into Papa Ruby, maybe its own thing)?
   This is the same shape of open question MINING.md left for Papa Ruby's
   output destination — don't guess at it without deciding deliberately.

3. **Relationship to `:mine` and `:mine --refine`.** Does `:committee`
   replace `:mine --refine` for some use cases, sit alongside it, or
   precede it (committee filters first, then Papa Ruby reasons only over
   committee-approved concepts)? The cleanest design is probably: committee
   voting is a *stricter alternative* to Papa Ruby's single-pass judgment —
   the user picks one path or the other depending on how much they trust a
   single local-model judgment vs. wanting majority-vote consistency. Worth
   deciding before implementation, since it affects whether `:committee`
   and `:mine --refine` can run on the same concepts or are mutually
   exclusive paths.

## Non-goals

- This is not a replacement for Papa Ruby. The two may end up being
  alternative paths over the same concepts (see open question #3) rather
  than one replacing the other.
- This does not change anything about how dreams, reconciliation, or the
  existing mining pipeline work. It is additive and isolated.
- This is not required for Aura to function, and unlike a daemon, it has
  truly zero cost when unused — no background process, no idle resource
  use, nothing to start or stop. See "Hard requirement" above.
