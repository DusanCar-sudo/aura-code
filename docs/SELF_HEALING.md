# Self-Healing — Automatic File Integrity Recovery

> Built into the agent loop itself, not a command. Fires only when a read
> or parse actually fails — never runs proactively on healthy files.

## Why this exists

Aura's memory and reference systems (episodes, dreams, reconciled memory,
skill files, project config) are all plain files on disk. Files can get
corrupted: a process killed mid-write, a disk error, a manual edit gone
wrong, a crash during a multi-step write. Today, a corrupted file simply
throws an unhandled error and stops whatever was using it — `:dream`
fails outright, `:mine` skips silently, a skill fails to load with no
clear explanation.

Self-healing replaces "crash or silently skip" with "detect, repair what's
safely repairable, clearly report what isn't, keep working."

## The hard rule that shapes everything below

**Not all files are healable the same way, and treating them the same is
dangerous.** Two categories, with permanently different rules:

### Static files — safe to fully replace

Files whose correct content is the same regardless of how much the system
has been used: source code (`src/**/*.ts`), documentation (`docs/*.md`),
committed skill files, config templates. These have a canonical original
in git. If corrupted, the fix is `git checkout -- <file>` — restore the
whole file from the last committed version. No new mechanism needed here;
git already is the self-healing system for this category. The only new
work is *detecting* corruption and *triggering* the restore automatically.

### Dynamic files — only snippet-level repair, never wholesale replacement

Files whose content is unique and grows with usage: `episodes/*.json`,
`dreams/*.md`, `dreams/.last.json`, `dreams/.reconciled.md`, `knowledge/`,
`research/*.md`, `council/*.md`, training data. These have **no canonical
original** — there is nothing to "download a fresh copy" of, because the
content is irreplaceable history specific to this project and this user.

For these, healing means: if a **known structural snippet** within the
file is broken — a missing required section header, a malformed
frontmatter block, an unparseable JSON fragment in an otherwise-readable
file — repair only that snippet using the file format's own known-good
shape. **Never replace the file. Never discard real content.** If the
damage isn't isolated to a recognizable snippet (the file is largely
unreadable, not just missing one section), do not attempt automatic
repair — quarantine and report (see below).

This distinction is the whole design. Violating it (treating dynamic
files like static ones) risks silently destroying irreplaceable data,
which is worse than leaving it broken and visible.

## Trigger: lazy, not proactive

Self-healing does **not** scan files preemptively or run on every read.
It fires only when something already failed:

- A `JSON.parse()` throws while loading an episode or `.last.json`.
- `parser.ts`'s dream-section parsing produces an empty or clearly
  truncated result where content was expected (e.g. a dream file with a
  title line but zero parsed sections, when the raw file is non-trivial
  in size — a strong signal of mid-write truncation, not an empty day).
- A skill file fails to load (frontmatter doesn't parse, or the file is
  unreadable).
- Any other existing `try/catch` around a file read that currently just
  logs and moves on becomes a point where the healing check is offered
  the chance to act, instead.

This keeps the cost at zero for the overwhelming majority of reads (which
already succeed) and only spends effort exactly when something is
already wrong.

## Repair flow

```
read/parse attempt
       |
       v
   succeeds? --yes--> done, no healing involved
       |
       no
       v
  is this a STATIC file (tracked in git)?
       |                          |
      yes                         no (dynamic)
       |                          |
       v                          v
  git checkout -- <file>    is the damage isolated to
  log: "restored <file>     a known snippet/section?
  from git (was corrupted)"        |                |
                                   yes               no
                                    |                |
                                    v                v
                          repair just that    quarantine the file
                          snippet using the   (move to <dir>/.corrupted/),
                          format's known      log clearly what broke and
                          shape (e.g. a       that it was NOT auto-fixed,
                          missing section     continue without crashing
                          header) -- leave
                          everything else
                          in the file
                          untouched
```

### Snippet repair, concretely

For dream files specifically (the clearest existing case, since
`parser.ts` already encodes the expected shape): if a dream file has a
valid title and at least one real section, but is missing an expected
section header entirely (e.g. truncated before `## Tomorrow brief` was
ever written), the repair is to **insert the missing header with an
explicit placeholder**, not to fabricate content:

```markdown
## Tomorrow brief

*[This section was missing -- the file may have been truncated during
writing. No content was recovered.]*
```

This keeps the file structurally valid (so the parser and reconciliation
no longer choke on it) without inventing lesson content that was never
actually produced. **No LLM call for repair, by default** -- same
philosophy as Baby Ruby: a placeholder is honest and free; calling a
model to "guess" what the missing section probably said is neither.
Re-derivation (asking a model to regenerate a missing section from that
day's episodes, if they're still available) can be added later as an
explicit, opt-in upgrade -- never the default behavior.

### Quarantine, concretely

When damage isn't isolated to a known snippet -- the file is mostly
unreadable, binary garbage, or structurally unrecognizable -- move it
aside rather than deleting it (in case manual recovery is possible later)
and log it visibly:

```
<original-dir>/.corrupted/<original-filename>.<timestamp>
```

Example log line, surfaced to the user the next time they run a command
that would have touched the file:

```
[!] episodes/a3f9c1-mqzz.json appears corrupted and could not be safely
    repaired. Moved to episodes/.corrupted/a3f9c1-mqzz.json.20260629.
    This episode's data may be lost.
```

Honest, visible, and it never pretends data was recovered when it wasn't.

## What this does NOT do

- Does not replace `episodes/`, `dreams/*.md`, `council/`, `research/`,
  or training data wholesale, ever, regardless of how badly corrupted --
  only isolated, recognized snippets within them get touched.
- Does not run as a background scan or scheduled job -- purely reactive
  to an actual failed read/parse.
- Does not call an LLM by default for repair -- placeholder-and-report is
  the baseline; re-derivation is a future, explicit opt-in.
- Does not touch credentials or config files (`telegram.json`,
  `.aura.json`) at all -- these are excluded entirely, since a "healed"
  default would have no working credentials and could silently break
  authentication in a way that's harder to notice than an outright error.

## Open questions for implementation

1. **Where does the static-vs-dynamic classification live?** Likely a
   small lookup keyed by path pattern (`src/**`, `docs/**` -> static;
   `episodes/**`, `dreams/**`, `research/**`, `council/**`,
   `training-data/**` -> dynamic), checked before any repair attempt.

2. **Does `git checkout` need the working tree to be clean for that
   file?** If a static file has *uncommitted* changes when it gets
   corrupted, restoring from git would discard those changes too. Worth
   deciding: warn and skip auto-restore if `git diff --quiet -- <file>`
   shows uncommitted changes, falling back to quarantine-and-report for
   that case specifically (treat it like a dynamic file for that one
   instance).

3. **Per-file-type snippet definitions** -- dream files have a clear
   known shape via `parser.ts` already. Episodes (`Episode` JSON) and
   `.reconciled.md` need their own "what does a healthy version of this
   look like" reference before snippet repair can be written for them.
   Build dream-file repair first (the shape already exists), then extend
   to other dynamic file types one at a time.
