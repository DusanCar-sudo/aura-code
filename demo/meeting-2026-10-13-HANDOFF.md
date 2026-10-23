# HANDOFF — Aura at the William Wong call, 2026-10-14

**Read this whole file before the call.** It is your brief: who you are talking to, what
you will perform, exactly which commands to run, what each one must print, and where
every file and PDF lives. Nothing here is aspirational — if it says "built", it runs on
this machine today. If it says "roadmap", it does not exist and you must say so out loud.

---

## 1. The situation

| | |
|---|---|
| **Who** | William Wong — investor. WhatsApp `+60122669533`, email `williamwong.cs@gmail.com` |
| **When** | 2026-10-14, **12:30 UTC** = **19:30 Da Nang** = **20:30 Kuala Lumpur** |
| **Where** | https://meet.google.com/ruw-sykn-yoe |
| **The ask** | **$4,800 for 60% of Aura Code** ($8,000 valuation) |
| **Dusan** | Joins muted after your first ~10 minutes alone with Wong. He screen-shares the terminal/TUI. |

**Talking points are in `demo/meeting-2026-10-13-one-pager.md`.** Read it. It has the
traction numbers, the hardware tiers and the honest limits. The invite you already sent
is `demo/meeting-2026-10-13-invite.md`.

**Three things were promised for this call:**
1. Aura books the meeting herself (the invite was composed and sent by you).
2. **Bookkeeping, end to end** — the main segment.
3. The product: ~900 npm downloads/month, the $99 founding licence gating the gateway.

---

## 2. Your role

You are not narrating slides. You are **operating**. Every claim on the call is backed by
a command you run in front of Wong, and the output is the proof. Speak what you are
doing as you do it.

Two rules you do not break:

- **Never fake a capability.** Supplier phone calls are roadmap (Twilio), not built. Say
  "not built", never "coming next week".
- **Never send to a supplier.** Reminder emails go to the business owner only.

---

## 3. Run of show

| # | Segment | Approx. length |
|---|---|---|
| 0 | Start recording → `:meeting` | 10 s |
| 1 | Bookkeeping, five steps, live | ~3 min |
| 2 | The ONE real reminder email | ~1 min |
| 3 | Two proof emails from Aura's own mailbox | ~2 min |
| 4 | WhatsApp step + honest statement about calling | ~1 min |
| 5 | Quarterly report + where the data lives | ~1 min |
| 6 | Stop recording → transcript → minutes | ~1 min |

---

## 4. Where the files and PDFs are

**This is the part everyone asks about. Memorise these paths.**

```
Invoices (8 PDFs, the raw material)
  /mnt/bigdata/aura/aura-code/demo/bookkeeping/invoices/
      AV-4471.pdf            CH-99231.pdf
      EB-2026-0520.pdf       EB-2026-0841.pdf
      KD-2026-0577.pdf       NO-88-2026-3312.pdf
      TB-2026-101877.pdf     TB-2026-119204.pdf

Regenerate them any time:
  node /mnt/bigdata/aura/aura-code/demo/bookkeeping/make-invoices.js

The scripted runner (all five steps in order)
  /mnt/bigdata/aura/aura-code/demo/bookkeeping/run-demo.ts
The written runbook (recovery table included)
  /mnt/bigdata/aura/aura-code/demo/bookkeeping/RUNBOOK.md
This handoff
  /mnt/bigdata/aura/aura-code/demo/meeting-2026-10-13-HANDOFF.md
The one-pager (talking points)
  /mnt/bigdata/aura/aura-code/demo/meeting-2026-10-13-one-pager.md

Ledger — plain JSON, yours, no cloud
  ~/.aura/bookkeeping/ledger.json
Quarterly reports
  ~/.aura/bookkeeping/reports/quarter-2026-Q3.md

Recordings, transcripts, minutes
  ~/Meetings/<ISO timestamp>/
      you.raw  them.raw  you-partial.wav  them-partial.wav
      transcript.md          ← produced on stop
      minutes.md             ← produced from transcript.md
```

**Answer the question "where is my data?" with:** plain JSON at
`~/.aura/bookkeeping/ledger.json` — readable, editable, backup-able, on your own disk,
no cloud. Every figure in it traces back to a parsed PDF.

---

## 5. Segment 1 — Bookkeeping, the main demo

Work from the repo root:

```bash
cd /mnt/bigdata/aura/aura-code
BK=$(mktemp -d /tmp/bk-live-XXXX)      # a clean ledger for the live run
echo "ledger home: $BK"
```

The disposable ledger is deliberate: if Wong questions a number, `mktemp` and re-run.
That is the point of the design, not an embarrassment.

**Drive it with the tool** (registered as `bookkeeping`) — say these in words and let
the agent call it, or run the scripted version:

```bash
AURA_HOME=$BK npx tsx demo/bookkeeping/run-demo.ts                   # dry: sends nothing
AURA_HOME=$BK npx tsx demo/bookkeeping/run-demo.ts --send leanproiq@gmail.com   # the ONE real send
```

### The five steps and what each must print

**Step 1 — invoices arrive.**
> "Aura, take the invoices in demo/bookkeeping/invoices into the ledger."

```
bookkeeping({ action: "ingest", path: "demo/bookkeeping/invoices" })
→ 8 of 8 parsed. Outstanding: €41,754.85
```

**Step 2 — the bank statement goes through the same book.**
> "These three were paid on the bank statement: AV-4471, EB-2026-0520, TB-2026-101877."

```
bookkeeping({ action: "mark_paid", invoice_no: "AV-4471",      paid_date: "2026-07-30" })
bookkeeping({ action: "mark_paid", invoice_no: "EB-2026-0520", paid_date: "2026-05-20" })
bookkeeping({ action: "mark_paid", invoice_no: "TB-2026-101877", paid_date: "2026-06-18" })
→ each marked paid with its date
```

**Step 3 — what is actually still owed.**
> "What is actually still owed?"

```
bookkeeping({ action: "list", status: "overdue" })
→ 5 overdue, €29,026.75, with days-overdue per invoice
```

**Step 4 — chase them.**
> "Chase them."

```
bookkeeping({ action: "dunning", dry_run: true })     # preview only
→ the reminder digest, nothing sent
```

Then the real send — **to your own address, never a supplier. Say that out loud:**
> "The reminder goes to the business owner. Aura never contacts a supplier."

```
bookkeeping({ action: "dunning", dry_run: false, to: "leanproiq@gmail.com" })
```

**Step 5 — quarterly report.**
> "Give me the quarterly report."

```
bookkeeping({ action: "quarterly", quarter: "2026-Q3" })
→ ~/.aura/bookkeeping/reports/quarter-2026-Q3.md
   totals, spend by supplier, aging buckets
```

### The honesty beat (do this one on purpose)

Run the same ingest twice and show the skip:

```
bookkeeping({ action: "ingest", path: "demo/bookkeeping/invoices/AV-4471.pdf" })
→ "already in the ledger" — skipped, with a reason
```

That is the parser being label-driven and reporting what it cannot read rather than
inventing it. It is the strongest thirty seconds of the demo.

---

## 6. Segment 2 — The two emails

The `email` tool is real: it talks to Gmail over SMTP via `msmtp`. Config lives in
`~/.aura/email.json` (0600) and `~/.msmtprc`.

**Send-as identity:** `aura@leanproiq.com` (alias of `milodule3@gmail.com`).
Default msmtp account is `leanproiq-dusan` = `dusan.milosavljevic@leanproiq.com`.

### Email 1 — proof of life, to Dusan's personal address

```json
{
  "action": "send",
  "from": "aura@leanproiq.com",
  "to": "milodule3@gmail.com",
  "subject": "Aura Code — live demo, 13 October",
  "body": "Hi Dusan,\n\nThis message was composed and sent by me, Aura, during the\nWilliam Wong call as proof that the email pipeline is wired to a real\nmail server.\n\nBookkeeping state at time of sending: 8 invoices ingested,\n3 settled, 5 overdue at €29,026.75.\n\n— Aura"
}
```

### Email 2 — second proof, to the business address

```json
{
  "action": "send",
  "from": "aura@leanproiq.com",
  "to": "leanproiq@gmail.com",
  "subject": "Aura Code — quarterly summary, 2026-Q3",
  "body": "Quarterly bookkeeping summary generated during the live demo.\n\nIngested: 8 supplier invoices, €41,754.85 total.\nSettled: 3 (AV-4471, EB-2026-0520, TB-2026-101877).\nOutstanding: 5 overdue, €29,026.75.\n\nFull report: ~/.aura/bookkeeping/reports/quarter-2026-Q3.md\nLedger: ~/.aura/bookkeeping/ledger.json\n\n— Aura"
}
```

**Success string looks like:** `Email sent to … from aura@leanproiq.com via SMTP
(smtp.gmail.com): "<subject>"`.

**On failure:** show the dry-run digest instead and say plainly that the SMTP account
needs its app-password dialog. **Do not attempt a live credential fix on the call.**

---

## 7. Segment 3 — The WhatsApp step

The `whatsapp` tool talks to the linked phone through the local bridge
(`aura-wa serve`, port 8794) — no credentials needed. Contacts are in
`~/.aura/wa-contacts.json`: `William` / `William Wong` = `+60122669533`,
`Mom` = `+381637692687`.

### What is actually built

| Action | Built? |
|---|---|
| `send` — text message | ✅ |
| `send_media` — media by URL | ✅ |
| `status` — linked-device health | ✅ |
| **place a voice/WhatsApp call** | ❌ **not built** |

**Do not claim a call.** The tool schema has no `call` action and the bridge exposes
only `POST /send` and `GET /health`. If Wong asks to see a call, say:

> "Phone calls are on the roadmap behind Twilio — not built yet. I would rather tell
> you that than demo something fake. What I can do right now is send a WhatsApp message
> through the linked device, with no credentials."

Then demonstrate a real send instead:

```json
{ "action": "send", "to": "William", "message": "Aura Code demo — this message was sent by Aura from the live call." }
```

**Recipient note:** Dusan's own WhatsApp number is not in `wa-contacts.json` yet
(only `Mom` and `William Wong`). To message or address Dusan by number, add it to
`~/.aura/wa-contacts.json` first, or pass the raw number with country code.

---

## 8. Segment 4 — Recording, transcript, minutes

Dusan's stated requirement: **record the whole meeting**, so the transcript exists and
the minutes can be written. If something is missed in conversation, it is caught in text.

```
:meeting          → starts recording both sides
:meeting stop     → stops, writes ~/Meetings/<timestamp>/
                      ├── you.raw / them.raw
                      ├── transcript.md     (speech → text, speaker-attributed)
                      └── minutes.md        (generated from transcript.md)
```

Minutes are generated automatically after transcription and are **ground-checked**: any
decision, action item or figure that cannot be traced back to the transcript wording is
dropped and reported as `dropped an ungrounded …`. So the minutes may be shorter than
the transcript — that is the feature working, not a failure.

If nothing was transcribed, you will see:
`… no speech was transcribed, so there are no minutes to write.`

---

## 9. The honest-gaps script — say these unprompted

Volunteering a gap before Wong finds it is worth more than any number on the slide.

- **Supplier phone calls:** "Roadmap, Twilio — not built. Not coming next week; not built."
- **Revenue:** "Pre-revenue. The licence page is live; the first sale is the next milestone."
- **Parse coverage:** "Label-driven. Anything it cannot read is reported as a skip with a
  reason — watch: *(run the double-ingest)* — 'already in the ledger'."
- **Data location:** "Plain JSON at `~/.aura/bookkeeping/ledger.json`. Yours, readable,
  editable, backup-able, no cloud."
- **Scale:** "~900 downloads a month — 900 potential users, each able to run it today."

---

## 10. If something goes wrong

| Symptom | Recovery |
|---|---|
| `pdftotext` missing | Falls back to bundled pdf.js automatically — nothing to do |
| Email send fails | Show the dry-run digest; say the SMTP account needs its app password. No live credential fix on the call |
| Ledger looks wrong | `BK=$(mktemp -d /tmp/bk-live-XXXX)` and re-run — the ledger is disposable, that is the point |
| Numbers questioned | Open `ledger.json` and the PDFs on screen; every figure traces to a parsed PDF |
| WhatsApp bridge down | `aura-wa serve` — report the outage, do not improvise a fake |
| Call asked for and unavailable | Roadmap line from §7, then demonstrate `send` instead |

---

## 11. Numbers to keep straight

| Figure | Value |
|---|---|
| Ask | **$4,800 for 60%** ($8,000 valuation) |
| Invoices ingested | **8 of 8** |
| Total invoiced | **€41,754.85** |
| Settled | **3** (AV-4471, EB-2026-0520, TB-2026-101877) |
| Still owed | **5 overdue, €29,026.75** |
| npm downloads | ~**900**/month (893 in last 30 days) |
| Licence | **$99** founding licence, gateway gate |
| Meeting time | 12:30 UTC / 19:30 Da Nang / **20:30 KL** |

---

## 12. First command of the call

```bash
:meeting
```

Start it before Wong joins. Everything after this is live.
