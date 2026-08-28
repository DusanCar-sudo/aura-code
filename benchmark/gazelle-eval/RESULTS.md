# Gazelle blind eval — first run

**Date:** 2026-08-28 · **Model (both paths):** `gemini/gemini-3.6-flash`
**Judge:** `gemini/gemini-3.6-flash`, blind · **n = 49** scored pairs (50 run, 1 excluded)

## Headline

| | helpfulness | correctness |
|---|---|---|
| gazelle | 3.92 | **4.82** |
| coder | **4.49** | 4.43 |
| delta | **−0.57** | **+0.39** |

**Tokens: 24,384 (gazelle) vs 2,780,108 (coder) — 114x fewer.**

Read those together. Gazelle is scored *less helpful* and *more correct*, at
about one percent of the tokens.

## By category — this is where the answer actually lives

| category | n | gaz help | cod help | Δ | gaz corr | cod corr | Δ | tokens |
|---|---|---|---|---|---|---|---|---|
| factual | 10 | 3.90 | 5.00 | −1.10 | 4.70 | 5.00 | −0.30 | 45x |
| explain | 10 | 4.10 | 5.00 | −0.90 | 4.90 | 4.90 | 0.00 | 52x |
| advice | 10 | 4.00 | 5.00 | −1.00 | 5.00 | 5.00 | 0.00 | 64x |
| creative | 10 | 4.00 | 5.00 | −1.00 | 4.60 | 5.00 | −0.40 | 46x |
| **ambiguous** | 9 | **3.56** | 2.22 | **+1.33** | **4.89** | 2.00 | **+2.89** | 341x |

Two distinct findings, pulling in opposite directions:

**1. On conversational prompts (n=40), correctness is a wash** — −0.17 — while
helpfulness reads −1.00. Gazelle is terser; whether that is "less helpful" or
just "shorter" is exactly what the caveat below puts in doubt.

**2. On ambiguous prompts, Gazelle wins decisively, on correctness by +2.89.**
The coder path scored **2.00 / 5 for correctness** here — it went and looked,
ran out of room, and answered anyway with things that were not so. Gazelle
offered to escalate on **9 of 9** and was right to. This is the escalation
design working exactly as intended, and it is the most interesting number in the
run — a 341x token difference *in Gazelle's favour on the axis that matters*.

## The caveat that limits this result

**The judge saturated.** On the 40 conversational pairs it gave the coder path
5/5 helpfulness **40 times out of 40**:

```
conversational helpfulness — coder  : {5: 40}
                             gazelle: {3: 10, 4: 20, 5: 10}
```

A judge awarding the identical maximum to forty different answers is not
discriminating between them. So **the −0.57 helpfulness gap should not be
treated as a measurement.** The most likely cause is length/structure bias — the
coder path emits long structured markdown, Gazelle is deliberately terse — and
possibly self-preference, since the judge is the same model family that wrote
both answers.

The correctness axis *did* discriminate (it handed the coder a 2.00 on
ambiguous), so correctness is the more trustworthy of the two numbers here.

Blinding itself held: mean score for position A was 4.22 vs 4.18 for B, and
Gazelle appeared as A in 25 of 49 pairs.

## What would make this conclusive

1. **A judge from a different family** (Claude or GPT scoring Gemini answers), to
   remove self-preference.
2. **A forced-choice rubric** ("which better serves the asker?") instead of two
   independent 1–5 scales, which is what saturated.
3. **Human scoring of a 15-pair subset** as a check on the model judge.

Until at least (1) and (2), the honest claim is: **Gazelle matches the coder path
on correctness for conversational work at ~1% of the tokens, and beats it on
questions needing tools by correctly declining to guess.** The helpfulness gap is
unmeasured, not established.

## Notes on method

- **One pair excluded** (`m05`): the coder path hit the 25-turn cap and produced
  "Loop ended after 25 turns" rather than an answer. Scoring a harness
  truncation against a real answer would have manufactured a Gazelle win.
- Nine ambiguous prompts were re-run at a 25-turn cap after the first pass
  truncated them at 6. The first-pass numbers are superseded, not averaged in.
- **114x is not the same measurement as the "26x per turn" claim.** This compares
  one Gazelle turn against one full coder *task* — an agent loop with tools,
  many turns. Both numbers can be true; they answer different questions. Do not
  quote 114x as an improvement on 26x.
- The coder path ran `read-only`, which permits `read_file`, `list_dir`,
  `search_code`, `git_status`, `git_diff` — enough for every ambiguous prompt, so
  its poor showing there is not tool starvation.
