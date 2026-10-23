# Archimedes verify — discovery (2026-10-23)

Read-only survey for the verify-layer rewrite. The repo root is
`/mnt/bigdata/aura/aura-code`; the handoff's `/mnt/bigdata/aura/` is its parent
folder and not a git repo.

Repo state at discovery: branch `release-0.20.0`, HEAD `94bc967`. Dušan's unrelated
uncommitted work was later committed to the local branch `wip/2026-10-23`.

## 1. Files and line ranges in the verify path

| File | Lines | Role |
|---|---|---|
| `src/archimedes/alternator.ts` | 158–165 | `inferTaskCategory`: regex buckets for review, research, refactor, implementation and other |
| `src/archimedes/alternator.ts` | 172–181 | `taskMode`: maps the category to `retrieval` or `design` (today's claim-type split) |
| `src/archimedes/alternator.ts` | 245–250 | the `ArchimedesVerification` type: `{ valid, reason, usage? }` |
| `src/archimedes/alternator.ts` | 269–302 | `summarizeToolActivity`: compresses the tool evidence the verifier sees |
| `src/archimedes/alternator.ts` | 314–395 | `verifyArchimedesAnswer`: the VALID/INVALID judge |
| `src/archimedes/alternator.ts` | 461–474 | `resolveVerifierProvider`: uses `verifierModel` if set, otherwise the large model |
| `src/archimedes/alternator.ts` | 491–931 | `ArchimedesAlternator.run`: gate, probe, small attempt, verify, escalation, council, then episode and cost row |
| `src/archimedes/claim-evidence.ts` | 1–148 | extracts claim terms and builds evidence excerpts for the verifier |
| `src/archimedes/competence.ts` | 148–209 | `assessCompetence`: the competence gate |
| `src/archimedes/episode-capture.ts` | 10–147 | episode store at `~/.aura/episodes/{projectHash}/{id}.json` |
| `src/archimedes/types.ts` | 1–225 | `Episode` and `ArchimedesConfig` types (`verifierModel` and `epsilonProbeRate` live here) |
| `src/archimedes/cost-log.ts` | 1–302 | per-attempt token ledger in `~/.aura/cost-log/`, aggregated by `:cost` |
| `src/mining/extract.ts` | 109–247 | Path A clustering; reads only `.task` and `.taskCategory` |
| `src/mining/corrections.ts` | 1–~120 | Path B: builds task → small answer → large answer pairs; run by `:mine` (`src/commands/core.ts:439`) |

`ArchimedesAlternator` is created in three places: `src/orchestration/strategy.ts:133`,
`src/cli/index.ts:1406` and `src/cli/index.ts:1895`.

## 2. Current call flow

1. **Competence gate.** `assessCompetence` (competence.ts:148) uses the small model when the pattern has fewer than `minAttempts` similar episodes, or when its success rate is at least `competenceThreshold`. Otherwise it routes to the large model.
2. **`:small1` override.** Forces the small model regardless of the gate (alternator.ts:555).
3. **Epsilon probe.** When the gate routed to the large model, `Math.random() < epsilonProbeRate` sends the task to the small model anyway (alternator.ts:571).
4. **Backend check.** The local backend is pinged; if it is unreachable, the task goes straight to the large model (alternator.ts:589).
5. **Small attempt.** The small model runs a read-only agent loop of at most 15 turns (alternator.ts:601).
6. **Verify, conditionally.** Verify runs only when the output is non-empty **and** `loopResult.success` is true (alternator.ts:631). Empty, truncated and failed runs skip verify and escalate.
7. **Verdict.** `verifyArchimedesAnswer` returning `VALID` means the small answer is returned. Anything else escalates, and the escalation carries the failure context (alternator.ts:639–659).
8. **Large model.** Runs a full agent loop (alternator.ts:701).
9. **Council (design tasks only, and only when a session budget is set).** The large model's answer is verified. If it is INVALID, the user is asked, then a 5-agent council runs and its answer is verified too (alternator.ts:731–835).
10. **Bookkeeping.** The episode is saved, a cost row is appended, and fine-tune readiness is checked.

The handoff's "five escalation triggers" do not appear anywhere in the source. These are the real causes of escalation:

- the gate is below threshold
- the backend is unreachable
- the small loop produced empty output or failed
- the small attempt threw
- the verifier said INVALID or errored

## 3. What the verifier actually checks

**The call.** One `complete()` call with no tools, sent to the large model (or to `verifierModel`). It receives the task, a claim-aware excerpt of the tool results and the answer, all together, and must reply with a single line.

**Retrieval mode** asks: is the answer correct and complete, and does it contradict the tool evidence?

**Design mode** has two parts:
- Part 1 is the same strict factual check.
- Part 2 judges the proposal with a coherence and relevance rubric.

**Parsing.** The reply passes only if `text.toUpperCase().startsWith('VALID')`. Anything else counts as INVALID, and so does any error.

**What it lacks:**
- no confidence score
- no hint
- no retry
- the judge reads the answer before it forms any expectation of its own

**Self-grading.** On the council path the large model grades its own output. The comment at lines 449–460 already says so.

## 4. Test coverage today

| Test file | Cases |
|---|---|
| `tests/archimedes/alternator.test.ts` | 13 |
| `tests/archimedes/cost-log.test.ts` | 14 |
| `tests/archimedes/claim-evidence.test.ts` | 11 |
| `tests/archimedes/verifier-provider.test.ts` | 6 |
| `tests/archimedes/escalation-correctness.test.ts` | 2 |
| `tests/archimedes/escalation-fullpath.test.ts` | 2 |
| `tests/mining/corrections.test.ts` | 8 |

The counts come from `grep -cE "^\s*(it|test)\("`.

Running `npx vitest run tests/archimedes tests/mining` gives **15 files passed, 246 tests passed**.

## 5. Token attribution today

**What exists.** `cost-log.ts` writes one row per request with three tiers: `smallModel`, `verifier` (every verify call summed together) and `largeModel`. Each tier records tokensIn and tokensOut. The numbers come from the provider's reported usage, or from `countText` when the provider reports none (alternator.ts:381–386).

**What is missing:**
- The six named buckets from the handoff.
- Tokens on the episode. The episode stores only the `tokensUsed.archimedes` and `largeModel` totals, with nothing for the verifier.
- Any check that the parts add up to the provider's total.
- Attribution for council tokens.

## 6. Findings the handoff did not anticipate

- **Bug at alternator.ts:865.** `...episodeLearningFields(...)` spreads a Promise: the function is async and the call has no `await`. As a result `filesTouched`, `diff`, `testResult` and `reviewerReason` are never saved on any episode. Part of the training-loop gap comes down to this one missing `await`.
- **"Mining drops the triplet" is only half true.**
  - `extract.ts` (Path A) does read only the task and its category.
  - `corrections.ts` (Path B) already emits task → small answer → large answer pairs from escalation episodes.
  - So the new work extends Path B with redirect pairs and a hint field rather than starting from scratch.
- **Empty or failed small output skips verify today** (step 6). The new rule, "verify after every small answer", changes that. An empty answer could go straight to escalate without paying for a judge call. *Decision needed.*
- **The council path makes its own verify calls** (step 9). Under "at most 2 verify calls per request" it has to be removed or exempted. *Decision needed.*
- **Existing token-saving claims:**
  - README lines 52, 63 and 168–179.
  - The README's Archimedes section, lines 276–286.
  - The header of `cost-log.ts`, which frames the whole gate as an economic claim.

## 7. Baseline test run (full suite, clean tree, before any change)

Dušan's uncommitted work was moved to the local branch `wip/2026-10-23` (commit `2a7f2e3`).
That left `release-0.20.0` (HEAD `94bc967`) clean. On the clean tree:

```
npx vitest run
 Test Files  211 passed | 1 skipped (212)
      Tests  3006 passed | 9 skipped (3015)
```

**Baseline: 0 failures.** The 27 failures seen earlier were all in test files that only exist on `wip/2026-10-23`:

| File | Failures |
|---|---|
| `context-policy` | 7 |
| `dictate-inject` | 2 |
| `email-attachments` | 6 |
| `repl-mode-commands` | 10 |
| `agent/swarm-concurrency` | 2 |

Those 27 are out of scope for this branch.

## 8. Decisions (Dušan, gate 1)

1. **Empty or failed small answers** escalate directly with no judge call. They still record a typed verdict: `reject`, with reason `empty` or `run_failed`. Never a silent skip.
2. **The council stays.** Its verify calls are excluded from the max-2 cap, stamped `selfGraded: true`, and counted in a 6th token bucket, `council`.
3. **The missing `await` at alternator.ts:865** gets fixed as the first commit.
4. **This is a repair, not a rewrite.** Build on `checks.ts`, `claim-evidence.ts`, the escalation-correctness harness, `cost-log.ts` and `mining/corrections.ts`.
5. **First step of §2:** replace `startsWith('VALID')` with a strictly parsed typed verdict (`accept | reject | abstain | unreachable`), and record errors separately from rejects.

## 9. Repair list (recorded 2026-10-23, not yet fixed)

1. **Silent Ollama fallback.** `src/archimedes/endpoint.ts:89-90` falls back to `'ollama'` when `backend` is missing, and it ignores a `"provider"` key. A `.aura.json` with `"provider": "lmstudio"` therefore sent LM Studio's port to the Ollama client and labelled it Ollama. Fix: error on a missing or unknown backend, or accept `"provider"` as an alias.
2. **localhost resolves to ::1.** Inside the CLI, `localhost` resolves to `::1`, but LM Studio listens on `127.0.0.1:1234` only, so the reachability ping gets `ECONNREFUSED`. Fix: default the local base URLs (`DEFAULT_LMSTUDIO_BASE_URL` and `DEFAULT_OLLAMA_BASE_URL`, endpoint.ts:15-16) to `127.0.0.1`, or try both addresses.
3. **Reasoning eats small token budgets.** lfm2.5-2.6b spent all 10 tokens of a `max_tokens: 10` call on reasoning and returned empty content. With 400 it returned "OK" after 97 reasoning tokens. Fix: the small-model call needs a token floor that leaves room for content.
