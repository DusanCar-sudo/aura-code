# Escalation-correctness — first live run

**Date:** 2026-08-28 · **Verifier:** `gemini/gemini-3.6-flash` · **n = 30 cases**

## Result

| outcome | n | rate |
|---|---|---|
| correct-routing | 28 | 93.3% |
| **missed-escalation** (primary) | **2** | **6.7%** |
| false-escalation | 0 | 0.0% |
| both-wrong | 0 | 0.0% |

**Missed escalation is the fabrication rate** — the verifier accepted a
plausible-but-wrong answer, so a bad answer ships. 6.7%.

**False escalation is 0%** — the verifier never rejected a correct answer, so
the gate is not costing double on work the small model got right.

## Where the misses are

Both are design-mode cases: `des-002-refactor` and `des-013-cache-key`.

| mode | cases | missed |
|---|---|---|
| retrieval | 15 | **0** |
| design | 15 | 2 (13.3%) |

Retrieval verification is clean at this sample size: when the answer makes a
checkable claim and the tool evidence contradicts it, the verifier catches it
every time. Design verification is weaker, which is what the split rubric
predicts — a design answer is judged on coherence and relevance rather than
contradiction, and coherence is exactly where a plausible wrong answer passes.

That is a useful, actionable shape: **the verifier's weakness is a rubric
problem in design mode, not a general unreliability.**

## Caveats

- n=30 is small. Two misses is the difference between 6.7% and 3.3%; do not
  quote this to two significant figures.
- One verifier model, one run. No variance estimate.
- This benchmark had **never run before**. It was excluded from `vitest.config.ts`
  (correctly, being slow and live) but pinned to `deepseek-chat`, so once that
  account lapsed it self-skipped — and a benchmark that skips is
  indistinguishable from one that passes. It now takes
  `AURA_ESCALATION_VERIFIER_MODEL`.

## How to reproduce

```bash
AURA_LIVE_BENCH=1 AURA_ESCALATION_VERIFIER_MODEL=gemini/gemini-3.6-flash \
  npx vitest run tests/archimedes/escalation-correctness.test.ts --testTimeout=600000
```

Takes about 5 minutes.

## Still owed

Tasks 8 and 9 asked for this set run *both ways* — before and after the
verifier-provider split, and before and after claim-aware truncation — to
measure whether either moves the missed-escalation rate. This run is the
**after** baseline for both, taken together. Separating their contributions
needs two more runs with each change reverted, which is worth doing precisely
because 2/30 is a thin margin to attribute anything to.
