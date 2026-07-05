# :aura heal — User-Triggered System Repair

> A command, not automatic. Diagnose first, propose a fix, wait for
> confirmation by default. `--auto` skips the wait for a faster pass.

## Why this exists

`:full heal <target>` / `:aura heal <target>` lets the user point Aura at
a named piece of software, driver, or system component — "nvidia
drivers," "steam," "docker," "the printer" — and have Aura investigate
and fix it, the same way a competent sysadmin would when asked "can you
fix my X."

This is explicitly **not** the same thing as file self-healing
(`docs/SELF_HEALING.md`). Self-healing is automatic, scoped to known file
formats inside the Aura project, and lazy (fires only on read failure).
`:aura heal` is the opposite on every axis: user-triggered, open-ended
(any named system component), and proactive (runs a real investigation
the moment it's invoked).

## What this is, mechanically

`:aura heal <target>` is mostly a **shorthand expansion**, not a new
subsystem. It does not need a fixed diagnostic checklist per app type —
that would require maintaining bespoke logic for every possible target,
which doesn't scale and isn't necessary. Aura already has the real tools
(`run_shell`, `read_file`, `edit_file`, web search) and the judgment to
investigate an unfamiliar problem; what's missing is just the dispatcher
shortcut that turns the command into a well-framed task.

```
:aura heal nvidia drivers
```

expands to something equivalent to handing the agent loop the task:

```
Diagnose and fix problems with: nvidia drivers.

Investigate current state first (versions installed, relevant logs,
service/driver status, recent errors). Identify what's actually wrong
before proposing a fix. Report your diagnosis and proposed fix, and
wait for confirmation before making any changes — unless this command
was invoked with --auto, in which case proceed directly after diagnosis.
```

This is why it's a small addition, not a new system: it reuses
`runAgentLoop` exactly as it already exists, with a task string built
from a template plus whatever the user typed as `<target>`.

## Default flow: diagnose-first

```
:aura heal <target>
       |
       v
  investigate (run_shell, read_file, web_search as needed --
  this part runs automatically, no confirmation needed for
  read-only investigation, same as any other task today)
       |
       v
  report: "Here's what's wrong with <target>: ... Proposed fix: ..."
       |
       v
  wait for user confirmation
       |
   yes/no
    |     \
   yes     no
    |       \
    v        v
  apply    stop, no changes made
  the fix
```

This default exists because system-level repairs (drivers, package
managers, services) carry more risk than project-file edits — a wrong
fix can break something the user depends on for things unrelated to
Aura entirely. Diagnose-first means the user always sees the plan before
anything changes.

### `--auto`: skip the wait

```
:aura heal <target> --auto
```

Runs diagnosis and fix in one pass, same as a normal Aura task today
under `normal` or `auto` permission mode — the existing permission system
still governs individual risky commands within that pass (confirmation
prompts for anything not in `SAFE_SHELL_COMMANDS`, blocks on anything
matching `DANGEROUS_PATTERNS`). `--auto` here means "don't pause between
diagnosis and fix," not "bypass the permission system" — those are
separate layers and this command doesn't touch the permission gate at
all.

## What this does NOT do

- Does not maintain a per-application diagnostic playbook. The model's
  general investigative ability (already proven tonight on the SDDM
  on-screen-keyboard fix and the surveillance-script investigation) is
  the mechanism, not a hardcoded checklist.
- Does not bypass or weaken the existing permission system. A `:aura
  heal` task is subject to exactly the same `auto`/`normal`/`read-only`
  gating as any other task — this command only changes *how the task is
  framed*, not what's allowed to run.
- Does not touch the sudo/password handling rules documented in
  `SECURITY.md` — if a fix needs elevated privileges, the same rule
  applies: rely on a pre-authenticated sudo timestamp or ask the user to
  run the privileged step themselves, never accept a password.
- Is not a replacement for asking Aura to fix something in plain
  language. `:aura heal nvidia drivers` and "my nvidia drivers seem
  broken, can you fix them" should produce essentially the same result —
  the command is a convenience shortcut with a built-in diagnose-first
  default, not a categorically different capability.

## Open questions for implementation

1. **Where does the task-template text live?** Probably a small constant
   in `cli/index.ts` near the other command handlers, parameterized by
   `<target>` and the `--auto` flag — mirrors how `:council` and `:mine`
   already parse their own flags.

2. **Should the diagnosis report get saved anywhere** (e.g.
   `research/<date>-heal-<target>.md`, matching `:research`'s output
   convention), so repeated `:aura heal` runs on the same target build a
   visible history of what's been tried? Leaning yes, for the same
   reason episodes exist — a record of "diagnosed nvidia drivers on
   2026-06-29, found X, fixed Y" is useful context for next time,
   cheaply, since it's just reusing the existing research-output pattern.

3. **Confirmation UX inside the REPL** — does "wait for confirmation"
   reuse the existing `confirmFn` pattern already used for risky shell
   commands (`replConfirmFn` in `cli/index.ts`), or does it need its own
   higher-level yes/no prompt before the agent loop even starts the fix
   phase? Reusing the existing pattern is simpler and more consistent;
   worth defaulting to that unless a concrete reason emerges not to.
