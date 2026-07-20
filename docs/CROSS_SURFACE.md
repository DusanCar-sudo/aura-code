# Cross-Surface Awareness — Lightweight Memory Bridging

> Aura on the PC REPL and Aura on Telegram stay separate conversations.
> This makes each one aware of what just happened on the other, without
> merging history or sharing a session.

## Why this exists

Aura runs on two surfaces today: the PC REPL (`src/cli/index.ts`) and a
standalone Telegram bot (`src/tools/telegram-bot.ts`). Both call the same
real machinery — `loadProjectContext`, `runAgentLoop`, `PermissionSystem`,
the same providers — against the same project root. Long-term memory is
already shared between them: both write episodes to the same
`<project>/episodes/`, so `:dream`, reconciliation, and mining all see
activity from both surfaces.

What's **not** shared is short-term conversational state. Each surface
keeps its own `history` array:

- The PC REPL: `activeChatHistory`, persisted via `sessionStore`
  (`~/.aura/sessions/<project>/`).
- Telegram: a separate, in-memory, per-Telegram-chat-ID map
  (`setChatHistory`/`getChatHistory` in `telegram-bot.ts`), not backed by
  `sessionStore` at all.

So if you fix something on the PC, then ask about it from Telegram five
minutes later, Aura on Telegram has no idea what you mean — it's a cold
start, even though the underlying work (and its episode record) already
exists on disk.

## What this is NOT

This is deliberately **not** full session continuity. The two surfaces do
not merge into one conversation, do not share a `sessionStore` entry, and
do not require rearchitecting either surface's history handling. That
would be a much bigger change (shared identity across surfaces, conflict
resolution if both are active at once, etc.) and isn't what's needed here.

This is also **not** a second memory system competing with dreams. It is
short-lived (default: 24 hours), small (default: last 8 entries total,
across both surfaces combined), and exists only to answer "what did I (or
the other surface) just do," not "what have I learned over time" — that's
still dreams' and mining's job.

## Design

### Storage

```
<project>/.aura/cross-surface.json
```

Per-project, matching how episodes and dreams are already scoped. Shape:

```json
{
  "recent": [
    { "surface": "pc", "timestamp": 1751234567890, "task": "fix the SDDM on-screen keyboard config", "success": true },
    { "surface": "telegram", "timestamp": 1751234890000, "task": "asked about swap size", "success": null }
  ]
}
```

- `surface`: `"pc"` or `"telegram"`.
- `timestamp`: ms, same convention as `Episode.timestamp`.
- `task`: the task text, truncated (suggest ~100 chars, matching
  `digestEpisode`'s existing truncation in `dream.ts`).
- `success`: `true`/`false` if the task completed with a clear result,
  `null` if it's an open/unresolved question (e.g. the user asked
  something and the answer is pending or was informational, not a
  pass/fail action).

### Write path

After every completed task on either surface — same point where an
episode already gets saved (`saveEpisode` calls in `cli/index.ts` and
presumably an equivalent in `telegram-bot.ts`) — append one entry to
`cross-surface.json`. Cap the array at the last 8 entries (drop oldest
first), and drop any entry older than 24 hours on every write (cheap
filter, no separate cleanup job needed).

**No LLM call for this.** Reuse the task string directly, truncated, plus
the boolean outcome already available at that point in the code. This
matches Baby Archimedes's philosophy — don't spend a model call when the data
you need is already sitting in a variable. If the plain task string proves
uninformative in practice, a summarization pass can be added later as an
opt-in upgrade — not a first-version requirement.

### Read path

In `context.ts`, alongside `loadReconciledMemory`, add a
`loadCrossSurfaceActivity(root)` that reads `cross-surface.json` (if it
exists), formats the recent entries as a short list, and exposes it as a
new optional field on `ProjectContext` (e.g. `crossSurfaceActivity?: string`).

In `system-prompt.ts`, inject it as a new small section — likely placed
near the existing `### Memory (from past sessions)` section, but visually
and semantically distinct since this is *recent* and *cross-surface*, not
*consolidated* and *long-term*:

```
### Recent activity (other surfaces)
- 3 min ago (telegram): asked about swap size [unresolved]
- 40 min ago (pc): fixed the SDDM on-screen keyboard config [done]
```

Only the entries from **other** surfaces than the one currently running
need to be shown — if PC is asking, show Telegram's recent activity and
vice versa (the current surface already has its own conversation history
in context; repeating it would be redundant). Implementation detail: the
loader needs to know which surface is calling it, so `loadProjectContext`
or the injection point needs a `currentSurface: 'pc' | 'telegram'`
parameter threaded through.

Optional, same pattern as reconciled memory: if the file doesn't exist or
the other surface has no recent entries, the section is omitted entirely
— no empty placeholder, no behavior change for users who only ever use
one surface.

## Open questions for implementation (next session)

1. **Does `telegram-bot.ts` already call `saveEpisode`?** This needs
   confirming before the write-path hook can be added — if Telegram
   doesn't currently save episodes at all (possible, given its history
   handling is separate from the CLI's), that's a prerequisite fix, and
   would also mean Telegram-surface activity currently isn't feeding
   `:dream`/mining either, which is a bigger finding than this doc's
   scope.

2. **File locking / concurrent writes.** If a PC task and a Telegram task
   complete at nearly the same moment, both might try to write
   `cross-surface.json` simultaneously. Given the low frequency of this
   in practice (a human is rarely doing two things at once), a simple
   read-modify-write with no explicit lock is probably fine — but worth
   a quick test rather than assuming.

3. **Exact truncation length and "X min ago" formatting** — cosmetic, but
   worth deciding once rather than guessing twice. Suggest matching
   existing conventions already in the codebase (`task.slice(0, 140)` in
   `dream.ts`'s `digestEpisode`, for consistency) rather than inventing a
   new number.

## Non-goals

- This does not give either surface access to the other's full
  conversation history — only a short, recent activity summary.
- This does not replace or change dreams, reconciliation, or mining. It
  sits alongside them as a much shorter-lived, much smaller signal.
- This does not require any change to `sessionStore` or how either
  surface manages its own conversation state.
