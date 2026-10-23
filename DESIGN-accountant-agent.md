# Design: the Accountant agent

*2026-10-22 — design only, for comparison against other proposals before build.*

Dušan's ask: a new agent, alongside Gazelle / Coder / Researcher, optimized for
accounting work — and faster than running the same job through the general loop.
Name: **Accountant**. (Gazelle is named for temperament; Accountant is named for
role. Deliberate — this one is defined by what it does.)

## The core insight

Accounting work is ~90% deterministic. The general agent loop spends most of its
turns on things a computer does better than a model: globbing PDFs, extracting
text, regex-parsing amounts, summing, filtering by date, formatting. The LLM is
only genuinely needed where input is messy (every supplier's invoice layout
differs) or output is prose (the dunning email, the quarterly summary).

So the Accountant inverts the loop: **a deterministic pipeline with LLM
checkpoints**, instead of an LLM driving tool calls turn after turn. The model
is the parser and the writer — never the calculator, never the navigator.

This is the Gazelle philosophy applied to a domain. Gazelle's header says it:
*"It shares the provider layer and nothing else: no tools, no ProjectContext, no
Archimedes."* The Accountant keeps that discipline and adds a fixed spine.

## Architecture (Variant A — Pipeline Accountant)

```
:accountant ingest ./invoices/
   |
   v
+-----------------------------------------------------------+
| STAGE 0  INTENT      (0-1 cheap LLM call, only if the      |
|          request is a compound utterance -> action list)   |
+-----------------------------------------------------------+
| STAGE 1  COLLECT     (0 LLM calls)                         |
|   glob PDFs -> pdftotext -> sha256 each text               |
|   skip files whose hash is already in the ledger (cache)   |
+-----------------------------------------------------------+
| STAGE 2  EXTRACT     (1 batched LLM call)                  |
|   all raw texts -> ONE prompt -> JSON array of             |
|   ParsedInvoice; validate against schema;                  |
|   per-item: 1 retry with the validation error inline,      |
|   then flag for human. No multi-turn repair loops.         |
+-----------------------------------------------------------+
| STAGE 3  RECONCILE   (0 LLM calls)                         |
|   parseAmount / parseDate (existing fns) are ground truth  |
|   over the LLM's output; dedupe by (supplier, invoice_no); |
|   merge into ledger in memory; write ONCE at stage end     |
+-----------------------------------------------------------+
| STAGE 4  ACT         (0 LLM calls)                         |
|   mark_paid, overdue math, dunning draft                   |
|   (dunning stays dry_run unless --send is explicit)        |
+-----------------------------------------------------------+
| STAGE 5  REPORT      (0-1 LLM call)                        |
|   deterministic numbers -> prose summary / digest email    |
+-----------------------------------------------------------+
```

**Max 2 LLM calls for the entire standard workload** (ingest 8 PDFs, mark 3
paid, list overdue, dunning, quarterly) vs ~30-60 turns through the general
loop. That is the speed claim, and it is measurable (see Benchmark).

## Where the speed actually comes from

1. **No agentic loop.** Each action is a fixed stage sequence. The general loop
   pays a turn tax on every tool call and re-reads growing context; the
   Accountant pays nothing per stage.

2. **Batched extraction.** N invoices = 1 LLM call (or ceil(N/20) calls under a
   token budget), not N sequential turns. Ingest is O(N) PDFs, O(1) LLM calls
   per batch — no per-invoice turn overhead.

3. **Constant, tiny context.** No ProjectContext, no repo scan, no skills, no
   mid-run memory recall. System prompt = JSON schema + a ledger summary
   (suppliers, open balance, today) + output rules. ~1-2K tokens, constant
   regardless of ledger size.

4. **Model routing.** Extraction is schema-filling: route to a cheap/fast model.
   Dunning prose and the quarterly summary get the good model. The provider
   factory already supports per-agent model pickers.

5. **Cache with explicit invalidation.** Key = sha256(extracted text) +
   PARSER_VERSION, stored on the ledger entry. Re-ingesting the same PDF costs
   0 LLM calls. Invalidation: PARSER_VERSION bump or ledger schema change —
   explicit, never time-based.

6. **The LLM never touches money.** Every amount and date passes through
   parseAmount / parseDate; if the model says €1.234,56 and the deterministic
   parser disagrees, the parser wins and the disagreement is logged. Sums,
   overdue days, quarterly totals are pure arithmetic. This removes the
   verification turns AND the classic failure mode of a model mis-summing.

7. **No loop, no stall.** The general loop needs repetition/cycle detection
   because it can wander. A pipeline cannot wander: every stage is succeed /
   retry-once / flag-for-human. Failure mode is a typed report, not a stuck
   session.

## Complexity notes

- Ingest: O(N) PDFs, one batched LLM call, single ledger write at end of
  stage 3 (one JSON rewrite, not per-invoice — avoids O(N) rewrites).
- Overdue / quarterly: O(N) scans over in-memory entries.
- No nested iteration traps: dedupe uses a Map keyed by (supplier, invoice_no),
  not .includes() inside a loop.
- Ledger stays plain JSON at ~/.aura/bookkeeping/ledger.json, same format —
  zero migration. If it ever grows past interactive size, append-only JSONL is
  the upgrade path; not needed now.

## Safety rails (money is the destructive class here)

- dunning: dry_run=true default (already the tool's behavior); real send only
  with explicit --send, and the recipient is the owner, never the supplier.
- mark_paid: requires explicit invoice_no (already enforced).
- The Accountant never invents a skip: parser reports skips, it does not
  fabricate entries (same honesty rule the demo runbook already follows).

## Where it lives in the codebase

- `src/agent/accountant-loop.ts` — the pipeline; sibling of gazelle-loop.ts,
  same philosophy (shares the provider layer and nothing else).
- `src/agent/accountant-prompt.ts` — extraction schema prompt + report prompt;
  sibling of gazelle-prompt.ts.
- Reuses `src/tools/bookkeeping.ts` pure functions — parseAmount (:123),
  parseDate (:145), parseInvoiceText (:170), formatMoney (:230) — imported,
  never duplicated. bookkeepingTool (:439) remains the tool-layer surface.
- REPL command `:accountant` next to `:coder` / Gazelle.

## Variants to compare

**A. Pipeline Accountant** (this doc) — fastest and most predictable: ~2 LLM
calls per standard workload, constant context, deterministic money math. Cost:
a new document type needs a schema/parser change. Build: 1-2 days.

**B. Orchestration specialist** — add 'accountant' to VALID_SPECIALISTS
(orchestrator.ts:85, currently researcher/coder/reviewer/planner), own system
prompt in specialist-prompts.ts, toolset = [bookkeeping, read_file, list_dir],
run with restricted permissions like the other specialists (specialists.ts:74
pattern). ~50 lines, reuses everything, ships in an afternoon. But it still
runs the general loop: 10-30 turns, growing context, exploration overhead.
Right v0, wrong end state.

**C. Gazelle-style tool-less** — rejected: accounting without ledger/file
access can only hallucinate numbers. Listed so the comparison is honest.

**Recommendation:** B as v0 this week (50 lines, immediately useful), A as v1
(the actual speed play). They are not rivals — B's specialist prompt becomes
A's stage-2 and stage-5 prompts verbatim.

## Benchmark (settles "is it faster" with numbers)

The meeting workload is the natural benchmark — it has known-good answers:
ingest 8 PDFs (EUR 41,754.85 total), mark 3 paid, list 5 overdue
(EUR 29,026.75), dunning dry-run then real send, quarterly 2026-Q3.

Run it three ways: (1) general loop, (2) specialist B, (3) pipeline A.
Metrics: wall time, LLM call count, tokens, USD cost, and correctness (ledger
diff against the known-good numbers). The winner is the one that matches the
ledger exactly with the fewest calls — speed without correctness is worthless
in accounting.
