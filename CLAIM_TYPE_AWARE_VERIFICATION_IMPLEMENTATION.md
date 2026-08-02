# Claim-Type-Aware Verification + Council Escalation — Implementation Complete

## Phase 3 Summary

Implementation completed as designed in Phase 2. All changes respect the constraints:
- **Do not weaken factual verification** — regression tests confirm fabrication is still caught
- **Respect cost work** — SessionBudget wired in, budget checks before council
- **Keep changes scoped** — touches only alternator.ts and council.ts

---

## What Changed

### 1. Task Mode Classification (`src/archimedes/alternator.ts`)

**New function: `taskMode(task: string): 'retrieval' | 'design'`**
- Maps task categories to verification axis
- `review`/`research` → `retrieval` (strict tool-evidence check)
- `refactor`/`implementation` → `design` (allows novel proposals)
- `other` checks for design-indicating phrases (`proposal`, `design`, `approach`, etc.)

### 2. Claim-Type-Aware Verification (`src/archimedes/alternator.ts`)

**Modified: `verifyArchimedesAnswer()`**
- Now branches prompt based on `taskMode(task)`

**Retrieval mode prompt** (unchanged behavior):
```
Does this answer correctly and completely address the task?
Critically: check the answer against the tool results above for
direct contradictions — if a tool says "not found" but the answer
describes it, that is fabrication → INVALID.
```

**Design mode prompt** (new two-part rubric):
```
PART 1 — Factual premises (must still be STRICT):
...same retrieval logic...

PART 2 — The proposal (different criteria):
Judge on: addresses task? internally coherent? demonstrates understanding?
acknowledges tradeoffs? contradicts hard constraints?
```

**The guard**: PART 1 remains strict. Fabrication-under-cover-of-proposal is prevented.

### 3. Design-Specific Council Prompting (`src/research/council.ts`)

**New functions:**
- `buildDesignPanelTask()` — prompts agents to propose DISTINCT approaches (divergent)
- `buildDesignSynthesisPrompt()` — produces menu of alternatives with tradeoffs, not single verdict
- `buildDesignSynthesisPrompt()` output sections:
  - Distinct approaches
  - Tradeoffs
  - Recommendation (verdict IS here)
  - Implementation notes

**Modified: `runCouncil()`**
- Accepts `mode?: 'research' | 'design'` parameter
- Defaults to `'research'` (backward compatible)
- Switches between `buildPanelTask()` and `buildDesignPanelTask()`
- Switches between `buildSynthesisPrompt()` and `buildDesignSynthesisPrompt()`
- Handles synthesis failure with mode-specific fallback

### 4. Council Escalation in Alternator (`src/archimedes/alternator.ts`)

**Added to `AlternatorOptions`:**
```typescript
sessionBudget?: SessionBudget;
```

**Escalation flow (after large model run):**
```
Large model completes
  ↓
Is taskMode === 'design'?
  ↓ Yes
Verify large model answer
  ↓
Did verification fail?
  ↓ Yes
Check sessionBudget.wouldExceed(ESTIMATED_COUNCIL_TOKENS)
  ↓ No
Run council with mode: 'design'
  ↓
Return council synthesis result
```

**Cost estimate:** 80k tokens conservative (5 agents × 6 turns × 2k + synthesis + padding)

**Budget enforcement:**
- If `wouldExceed()` returns budget stop, skip council with warning
- Council result read from `councilResult.path`, synthesis extracted before "Raw panel proposals"
- Falls back to large model output if council errors

### 5. SessionBudget Integration (`src/archimedes/alternator.ts`)

**Added import:**
```typescript
import type { SessionBudget } from '../agent/session-budget.js';
```

**Usage:**
- Passed via `AlternatorOptions.sessionBudget`
- Checked before council escalation: `this.opts.sessionBudget.wouldExceed(ESTIMATED_COUNCIL_TOKENS)`
- If exceeded, skips escalation and logs warning

### 6. Regression Tests (`tests/archimedes/alternator.test.ts`)

**Three new tests in "claim-type-aware verification" suite:**

1. **REGRESSION: fabrication in retrieval tasks**
   - Tool says "not found", answer describes function in 600 words
   - Expected: INVALID, escalation to large model
   - Confirms original fabrication case still caught

2. **Novel proposals allowed in design tasks**
   - Design task proposes solution not in codebase
   - Factual premises correct (tool confirms current state)
   - Expected: VALID, no escalation

3. **Fabricated factual premises rejected in design tasks**
   - Design task describes current state that contradicts tool evidence
   - Expected: INVALID (PART 1 failed), escalation

**All tests pass** (13/13 including existing tests).

---

## Escalation Ladder (Final)

```
Archimedes (Ollama)
  ↓ verifyArchimedesAnswer (design-aware)
Large model
  ↓ verifyArchimedesAnswer (design-aware) + design-mode check + budget check
Council (design tasks only, 5 agents, mode: 'design')
```

**Council gating:**
- Never automatic on all design tasks
- Only fires when large-model answer ALSO fails verification
- Requires `sessionBudget` in AlternatorOptions
- Respects `wouldExceed()` ceiling

---

## Design Verdict Preservation

The design goal from Phase 2:

> **"Prevent fabrication-under-cover-of-proposal"**

**Implemented as:**
- PART 1 of design verification rubric remains strict
- "The compaction ladder fires at 0.55" must match tool evidence
- Only the recommendation ("we should add a cap") is judged by design criteria
- Fabricated premises → INVALID even if the proposal is sound

**Regression test #3** explicitly validates this guard.

---

## Cost Discipline

**Token control points:**
1. `taskMode()` classification: 0 tokens (regex-based, no LLM call)
2. `verifyArchimedesAnswer()`: 1 cheap `complete()` call per verification (Archimedes + optional large model)
3. Council: checked against `SessionBudget.wouldExceed()` before firing
4. Council estimate: 80k tokens (conservative, includes all agents + synthesis + padding)

**No silent runaway:**
- If budget check fails, explicit warning logged
- Council not skipped silently — user sees why
- Falls back to large model output (already produced)

---

## Open Question (Not Implemented)

**From Phase 2 proposal:**

> Should the system flag to the user when a design task passes verification on the first try, offering an optional council run anyway?

**Not implemented** in this phase. Requires UX decision:
- Auto-prompt? ("The proposed solution looks sound — want a second opinion?")
- CLI flag? (`--council` to force council run)
- Separate command? (User runs `:council <task>` manually)

**Current behavior:** Council only fires on verification failure + budget allows. User can still explicitly run `:council` or `:ecclesia` commands for any task.

---

## Files Modified

1. `src/archimedes/alternator.ts`
   - Added `SessionBudget` import
   - Added `runCouncil` import
   - Added `sessionBudget` to `AlternatorOptions`
   - Added `taskMode()` function
   - Modified `verifyArchimedesAnswer()` for design-aware branching
   - Added council escalation logic after large model run

2. `src/research/council.ts`
   - Added `CouncilMode` type
   - Added `buildDesignPanelTask()` function
   - Added `buildDesignSynthesisPrompt()` function
   - Modified `runCouncil()` to accept `mode` parameter
   - Updated synthesis fallback for design mode

3. `tests/archimedes/alternator.test.ts`
   - Added "claim-type-aware verification" describe block
   - Added 3 regression tests (fabrication in retrieval, novel proposals in design, fabricated premises in design)

---

## Verification

Run tests:
```bash
npm test -- tests/archimedes/alternator.test.ts
```

All 13 tests pass.

**Key regression verified:** The documented fabrication case (600-word description of a function `search_code` returned nothing for) is still caught as INVALID after the design-aware changes.

---

## Next Steps (Optional, Out of Scope)

1. **UX for optional council run** — implement the "offer second opinion" flow
2. **Metrics** — track how often council fires, what percentage of design tasks reach it
3. **Tuning** — adjust ESTIMATED_COUNCIL_TOKENS based on actual runs
4. **Budget propagation** — wire SessionBudget through all callers of `ArchimedesAlternator` (currently only in orchestration layer)
