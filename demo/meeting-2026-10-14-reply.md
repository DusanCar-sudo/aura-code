# Reply to Wong's reschedule — SUPERSEDED by demo/send-wong-reply.ts, which was SENT 2026-10-13 21:10
# (final text differs: 8:30 KL confirmed, simplicity loop, 4 HTML attachments; this file keeps the earlier draft)
# Original: Reply to Wong's reschedule — DRAFT, not sent (2026-10-13)

Wong emailed at 15:08: **"Hi Aura, can make it tomorrow 8.39 pm?"** — he is addressing
Aura directly, which is the first demo promise working before the call happens.
The reply confirms his exact words with both timezones (so a typo would surface), keeps
the same Meet link, folds his 20-module PMS requirements into the agenda, and leads
with simplicity — he is not an engineer and neither are his buyers.

**Times:** Wed **2026-10-14, 20:39 Kuala Lumpur = 19:39 Vietnam (UTC+7) = 12:39 UTC**
Wong = UTC+8 (WhatsApp: "1.30 pm my time = 12.30 pm your time"). "8.39" is unusual —
the reply offers the 8:30 correction rather than silently normalizing it.

Per Dusan: the "two honest notes" line (no revenue / phone calls roadmap) is **removed**
from this reply.

## Send command (once Dusan says go)

```bash
cd /mnt/bigdata/aura/aura-code
npx tsx -e "
import { emailTool } from './src/tools/email.js';
emailTool({
  action: 'send',
  to: 'williamwong.cs@gmail.com',
  subject: 'Re: Aura Code — demo + investment discussion — Wed 14 Oct, 20:39 KL',
  body: \`Hi William,

Yes — tomorrow, Wednesday 14 October, 8:39 pm Kuala Lumpur (= 7:39 pm Vietnam,
12:39 UTC). Same Meet link: https://meet.google.com/ruw-sykn-yoe

If 8.39 was meant to be 8.30, say the word and I will move it.

Your 20-module requirements came through. The billing piece is what I will put on
screen: one invoice handed to Aura, and she does the rest — reads it, checks it,
keeps the aging current, chases what is overdue, generates the report. Built for
people who are not engineers: hand Aura the document, say approve, nothing else
to learn.

Unchanged: the meeting booked by Aura, the bookkeeping run, and the product
(Aura Code, ~900 downloads a month, founding licence page live).

See you tomorrow evening,
Aura (with Dusan)\`,
}).then(r => console.log(r));
"
```

## After it is sent

1. Wong's confirmation of the exact time (if he corrects 8.39 → update).
2. `demo/meeting-2026-10-13-HANDOFF.md` + `MEETING-RUNBOOK.md`: date/time headers
   still say 2026-10-13 05:30 UTC — move to 2026-10-14 12:39 UTC once confirmed.
3. Pinned briefing topic `meeting-wong-2026-10-13` in `~/.aura/memory/` — same update.
