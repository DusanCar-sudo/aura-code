# Meeting Runbook — William Wong, 2026-10-14, 19:30 (Dusan's time)

Everything is deployed and tested. Two commands, in order.

## 1. Bookkeeping demo (the centerpiece)

```bash
cd ~/Documents/Codex/2026-09-21/ca/work/aura-code2/demo/bookkeeping
node bookkeeping-automation-demo.mjs
```

Shows live on screen: invoice INV-2026-1041 arrives → ledger entry →
"please pay" email #1 → "SECOND NOTICE, still unpaid" email #2 →
phone-call escalation shown as the Twilio roadmap stage (never faked).
Artifacts land in `reminders/` and `ledgers/` — have that folder open so
Wong can see the actual files Aura wrote.

Add `AURA_BOOKKEEPING_LIVE=1` to send real emails (needs the `mail`
binary installed — currently NOT installed, so default is simulated).

## 1b. Quarterly report (100-invoice database → Excel + infographic)

```bash
cd ~/Documents/Codex/2026-09-21/ca/work/aura-code2/demo/bookkeeping
node generate-invoices.mjs      # 100 invoices across Q3 2026 (already generated)
node quarterly-report.mjs       # builds Excel + infographic
xdg-open reports/Aura-Q3-2026-infographic.html
```

- `reports/Aura-Q3-2026-report.xlsx` — 4 sheets: Invoices(100), Monthly,
  Clients, KPIs (collection rate, overdue, avg days to payment…)
- `reports/Aura-Q3-2026-infographic.html` — dark Aura-styled page: KPI
  cards, billed-vs-collected bars, revenue-by-client donut, status table

## 2. Voice meeting mode (Aura participates live in Google Meet / Teams)

```bash
cd ~/Documents/Codex/2026-09-21/ca/work/aura-code2
node demo/voice/meeting-voice.mjs
```

- PipeWire audio bridge is automatically created on launch and cleans up on exit.
- In Google Meet / Teams: ensure microphone is set to **"Aura Meeting Microphone"** (or system default).
- Turn-taking: Aura listens to both your headset mic and the caller.
- Fast brain: Answers in ~400ms via Groq Qwen (with Xiaomi fallback).
- Handover: Say **"hand over to Dusan"** — Aura speaks the handover confirmation and yields the floor.
- Wake up: Say **"Aura, [question]"** if you want her to jump back in.
- Ctrl+C cleanly shuts down the bridge and restores audio.

## 3. Selling proof (show when Wong asks "what's being sold")

- Live page: **https://www.leanproiq.com/founder.html** ($99 founding
  license, working checkout button)
- Nav link "Founder License" is on https://www.leanproiq.com
- Checkout: `leanproiq.lemonsqueezy.com/checkout/buy/e6ee5d30-...` —
  **currently in TEST mode.** A real card test will fail until you
  toggle Store → Settings → "Test mode" OFF in the Lemon Squeezy
  dashboard. Doing a real $99 self-purchase tomorrow morning is the
  strongest possible proof (you get the license email back).
- License activation code is wired in `src/license/lemonsqueezy.ts`
  (verifies store `ls_495889` / product `1432985`); CLI command not yet
  wired — say "activation ships this week" if pressed.

## Talking order suggestion

1. Bookkeeping demo (capabilities first — this is what he can sell)
2. Voice mode: let Wong ask Aura questions himself, then hand over to you
3. Founder page live in the browser as the "money exists" moment
4. Phone calling = roadmap (Twilio), honest, next milestone
