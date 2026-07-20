# Experience Mining — Baby Archimedes & Papa Archimedes

> Not "AI that trains itself." A system that extracts reusable knowledge
> from experience, then reasons about it.

## Why this exists

Aura's existing memory loop (episodes → dream → reconciliation → `.reconciled.md`)
answers "what does Aura believe?" It does not answer "how does Aura get
measurably better at specific recurring tasks?" Experience mining closes
that gap with a two-stage pipeline:

```
episodes (raw experience)
  → Baby Archimedes (no LLM — pure statistics, clustering, frequency)
    → concepts (structured, not yet training data)
      → Papa Archimedes (local LLM — reasoning, refinement)
        → training data / refined knowledge
```

**Baby Archimedes = observation.** Boring, deterministic, no model calls, no cost,
always available. Status: **shipped** (`src/mining/extract.ts`).

**Papa Archimedes = reasoning.** Local LLM (Ollama), takes Baby Archimedes's concepts as
input, produces `TrainingExample[]` (the type already exists in
`src/archimedes/types.ts`). Status: **shipped** (`src/mining/refine.ts`) — run the
whole pipeline via `:mine --refine`; accepted lessons append to
`training-data/<date>.jsonl`.

## What Baby Archimedes produces (already shipped)

```ts
interface MinedConcept {
  concept: string;        // slug, e.g. "authentication_token_bug"
  category: TaskCategory; // research | implementation | review | refactor | other
  examples: string[];     // up to 5 representative task strings
  frequency: number;      // how many episodes contributed
  confidence: number;     // mechanical: cluster size / total, depth-boosted
  depth: number;          // 1-3, how many recursive splits found this concept
  keywords: string[];     // shared significant words that define the cluster
}
```

Call: `mineExperience(projectRoot) → Promise<MiningResult>`. No network calls,
no API keys needed, runs in milliseconds even on hundreds of episodes
(termination is depth-bounded at 3, size-bounded at MIN_CLUSTER_SIZE=3).

## What Papa Archimedes should do (spec for next session)

### Input
All `MinedConcept[]` from Baby Archimedes, optionally filtered by minimum
confidence (e.g. only concepts with confidence ≥ 0.4 are worth an LLM call —
don't waste tokens reasoning about noise).

### Job
For each qualifying concept, one local-model call that:
1. Reads the concept's `examples`, `keywords`, `frequency`, `confidence`.
2. Decides: is this concept *actionable* (a real, generalizable lesson) or
   *noise* (coincidental keyword overlap with no real pattern)?
3. If actionable, writes ONE `TrainingExample`:
   ```ts
   {
     instruction: string;  // generalized question/directive
     input: string;        // task context
     output: string;       // the lesson, phrased as correct behavior
     metadata: {
       projectRoot, taskCategory, timestamp,
       archimedesFailureReason?: string;  // optional, if known
     }
   }
   ```

### Where output goes
Two destinations, matching the existing fine-tune pipeline types in
`archimedes/types.ts`:
- Append to a training corpus file (e.g. `training-data/<date>.jsonl`),
  one `TrainingExample` per line — this is the exact shape needed for the
  fine-tuning workflow you already use for the Serbian Legal LLM project.
- Optionally trigger a `FineTuneJob` (the type already exists) once enough
  examples accumulate — but that's a v2 concern, not first-build scope.

### Failure mode
Same invariant as dream reconciliation: Papa Archimedes is **best-effort**. If the
local model is unreachable or returns garbage, Baby Archimedes's concepts are
already safely computed and saved — nothing is lost. Papa Archimedes just doesn't
run this cycle; try again next time.

### Suggested file
`src/mining/refine.ts` — mirrors the shape of `src/dream/reconcile.ts`
(which already does "take structured input, one LLM call per batch, produce
verdicts, write output, best-effort"). Reuse that pattern; don't invent a
new one.

### Suggested CLI wiring
```
:mine              — runs Baby Archimedes only, shows concepts in terminal
:mine --refine     — runs Baby Archimedes, then Papa Archimedes on qualifying concepts
```
Same two-tier pattern as `:dream` vs `:dream` (auto-reconciles at ≥3 dreams).
Here the gate could be: only refine concepts with `confidence ≥ 0.4` and
`frequency ≥ 5` — i.e., don't bother the LLM with weak signal.

## Open questions for next session

1. **Local model choice for Papa Archimedes** — same Ollama fallback model as
   dream consolidation (`llama3.2`), or should this use the ArchimedesAlternator's
   configured small model (`qwen2.5-coder:1.5b` per `DEFAULT_ARCHIMEDES_CONFIG`)?
   Leaning toward the latter — it's already the "small model" in this
   codebase's vocabulary, and Papa Archimedes's job (judgment calls on concepts)
   is closer to what ArchimedesAlternator already does than to dream consolidation.

2. **Where do refined training examples actually get used?** Right now
   `FineTuneJob` exists as a type but nothing in the codebase appears to
   submit one. Worth checking whether there's a real fine-tuning backend
   already wired (Ollama supports LoRA fine-tunes; some cloud providers do
   too) or whether Papa Archimedes's output is, for now, just a clean `.jsonl`
   file the user feeds into an external fine-tuning pipeline by hand —
   same as how the Serbian Legal LLM corpus was built.

3. **Should Papa Archimedes read `.reconciled.md` too?** Dream reconciliation
   already produces refined beliefs. Baby Archimedes mines raw episodes
   independently. There may be useful overlap — a concept Baby Archimedes finds
   ("authentication bugs cluster around state mismatch") might already be
   stated, more eloquently, in `.reconciled.md`. Papa Archimedes could deduplicate
   against reconciled memory before writing a new training example, avoiding
   redundant rows. Worth deciding before building, not after.

## Non-goals (keep Papa Archimedes small)

- Papa Archimedes does not replace ArchimedesAlternator's routing logic.
- Papa Archimedes does not call the large/expensive model — local only.
- Papa Archimedes does not need to handle every concept — low-confidence concepts
  can just be skipped, no need to force a verdict on noise.
