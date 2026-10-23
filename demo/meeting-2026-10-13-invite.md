# Meeting invite — SENT (William Wong, 2026-10-13)

**Sent** to williamwong.cs@gmail.com via Aura's email tool (msmtp), with the real Meet
link `https://meet.google.com/ruw-sykn-yoe` substituted for `MEET_LINK` — the first of
the two demo promises ("she can do the whole meeting").

## Send command (once the link exists)

```bash
cd /mnt/bigdata/aura/aura-code
npx tsx -e "
import { emailTool } from './src/tools/email.js';
emailTool({
  action: 'send',
  to: 'williamwong.cs@gmail.com',
  subject: 'Aura Code — demo + investment discussion, tomorrow 13:30 your time',
  body: \`Hi William,

Confirming our call: Tuesday 13 October, 13:30 Kuala Lumpur (12:30 Hanoi, 07:30 Belgrade).

Join: https://meet.google.com/ruw-sykn-yoe

On the call I will show Aura running live, not slides:

1. Aura books this meeting herself — the invitation you are reading was written and
   sent by her, not by me.
2. Bookkeeping, end to end: eight supplier invoices parsed into a ledger, the overdue
   payments chased with a real email, and the quarterly report generated in front of you.
3. The product: Aura Code, ~900 downloads a month, with the new founding licence that
   gates the local inference gateway — one real price you can click and buy.

Two honest notes in advance: there is no revenue yet beyond the licence page, and
supplier phone calls are roadmap (Twilio), not built. Everything else on the list
runs live.

Talk tomorrow,
Dusan\`,
}).then(r => console.log(r));
"
```

## Facts to keep straight in the conversation

- Time is agreed in WhatsApp: "1.30 pm my time (12.30 pm your time)" — 13:30 KL.
- Platform: Meet — https://meet.google.com/ruw-sykn-yoe (sent with the invite).
- Wong's address: williamwong.cs@gmail.com
- The invite itself is demo material: say plainly that Aura composed it.
