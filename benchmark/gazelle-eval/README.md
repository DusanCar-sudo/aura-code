# Gazelle blind eval

Gazelle's headline number — 26x fewer tokens per turn — is a **token**
measurement with no quality comparison beside it. A cheaper path that answers
worse is not a win, and until this harness existed nothing here could tell the
difference. This produces the missing half.

## Running it

```bash
npm run build
node benchmark/gazelle-eval/run.mjs                    # all 50 prompts
node benchmark/gazelle-eval/run.mjs --limit 5          # smoke run
node benchmark/gazelle-eval/run.mjs --model gemini/gemini-3.6-flash
```

Then score, blind:

```bash
# a third model, told nothing about which path produced what
node benchmark/gazelle-eval/score.mjs --sheet results/sheet-<stamp>.json \
  --judge gemini/gemini-3.6-flash

# or score them yourself, interactively
node benchmark/gazelle-eval/score.mjs --sheet results/sheet-<stamp>.json
```

## How the blinding works

`run.mjs` writes three files:

| File | Contains | Who sees it |
|---|---|---|
| `run-<stamp>.json` | full record, labels intact, token counts | analysis only |
| `sheet-<stamp>.json` | pairs as "A" and "B", **shuffled, labels stripped** | the scorer |
| `key-<stamp>.json` | which of A/B was which path | **never the scorer** |

A/B order is decided by an independent coin flip per pair, so a scorer cannot
learn "A is always the short one". `score.mjs` reads the key **only after every
score is recorded** — until that moment nothing in the scoring process knows
which path produced which answer. That property is the whole point; without it
the numbers are worthless.

The harness also runs with a silent display, so nothing streams to the terminal
where a human scorer might see it.

## Design choices worth knowing

- **Both paths run the same model.** This measures the *path*, not the model.
  Running a small model on one side and a large one on the other would answer a
  different question than the one asked.
- **The coder path runs `read-only`.** A conversational prompt must never mutate
  the repo the harness runs inside.
- **The prompt set is conversational, not coding tasks.** 50 prompts across
  factual / explain / advice / creative / ambiguous. Loading it with coding tasks
  would rig the comparison toward the tool-using path and prove nothing.
- **Ambiguous prompts are deliberate.** For "why is my build slow?", Gazelle
  *offering to switch to coder mode* is the correct answer, not a failure. The
  record keeps `offeredEscalation` so scoring can account for it.

## Reporting

`score.mjs` prints the score delta with the token delta beside it, always. Report
them together: a cheaper path that answers worse is not a win, and a quality
difference without its cost is not a decision.

**If Gazelle scores worse, that is the finding.** Report it.
