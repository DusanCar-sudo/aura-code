# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: **leanproiq@gmail.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: within 48 hours
- **Assessment**: within 1 week
- **Fix release**: depends on severity (critical = days, low = next minor release)

## Responsible Disclosure

We appreciate responsible disclosure. If you report a valid vulnerability, we will credit you in the release notes (unless you prefer to remain anonymous).

---

## Scope: what Aura can actually do

Aura is an autonomous coding agent: it reads your files, writes code, runs shell
commands, and — depending on what's connected — can send email, install scheduled
jobs, control a browser, and message Telegram/WhatsApp. That's a wide blast radius
if you don't know what it will and won't ask permission for. This section states
that plainly, with file/line references into the actual source, not aspirational
descriptions of how it's "supposed to" behave. (Verified against v0.6.1.)

### The honest summary

- **There is no sandbox.** `run_shell` and every other tool execute with the full
  filesystem and process permissions of whoever is running `aura`. If that's your
  normal user account, Aura can do anything your shell can do.
- **Only three tool calls require confirmation in normal mode**: `run_shell` (for
  non-whitelisted commands), `write_file`, and `edit_file`. Every other tool —
  `email` (send), `cron` (install scheduled jobs), `telegram`, `whatsapp`,
  `browser`, `http_request`, `mcp`, and others — executes with **no confirmation
  prompt at all** in normal mode. This is the single most important thing to
  understand before turning Aura loose on a task. See
  [Tool-by-tool confirmation behavior](#tool-by-tool-confirmation-behavior) below.
- **The permission system does not restrict file access to the project root**,
  except for one specific case (recursive `find`/`grep`/`rg`, see
  [Shell command blocking](#shell-command-blocking)). A `run_shell` call to read
  or modify a file anywhere on disk is only checked against the dangerous-pattern
  blocklist, not a root boundary.
- **`:approve all` removes the remaining confirmations too**, including the
  shell/file ones. Use it deliberately, not as a default.
- API keys and OAuth tokens are written to disk with `0o600` permissions
  (owner read/write only) — see [Where secrets live](#where-secrets-live).

### How the permission system actually works

Every tool call the agent makes passes through `PermissionSystem.check()`
(`src/safety/permissions.ts`) before it executes. There are three levels, set via
`:approve <level>` in the REPL:

| Level | Set via | Behavior |
|---|---|---|
| `read-only` | `:approve read-only` | Only `read_file`, `list_dir`, `search_code`, `git_status`, `git_diff` are allowed. Everything else is blocked outright — no confirmation, just refused. |
| `normal` (default) | `:approve normal` | Safe shell commands and tools other than `run_shell`/`write_file`/`edit_file` run immediately. Non-whitelisted shell commands and any file write ask for a `[y/N]` confirmation first. |
| `auto` | `:approve all` | Everything runs immediately except commands matching the dangerous-pattern blocklist. **No confirmations of any kind**, including file writes and shell commands. |

#### Tool-by-tool confirmation behavior

This is the part most worth reading carefully, because the tool names suggest
more uniformity than the code actually has. In **normal mode**:

**Asks for confirmation:**
- `run_shell` — only if the command does *not* match the `SAFE_SHELL_COMMANDS`
  prefix list. That list is broader than "read-only": it whitelists `ls`, `cat`,
  `git status`/`log`/`diff`/`show`, `npm test`/`run`, `tsc`, `node` — but also
  `cp`, `mv`, `mkdir`, `touch`, `curl`, and `git add`/`git commit`/`git branch`.
  Anything not on that list asks for confirmation; anything on it runs immediately,
  including `git commit` and file moves.
- `write_file`, `edit_file` — every call, unless you've already approved that exact
  file path once this session (per-path session memory, not a blanket toggle)

**Runs immediately, no confirmation, in normal mode:**
- `email` — can send mail via system `sendmail`/`msmtp` or configured SMTP
  (`src/tools/email.ts`)
- `cron` — can install real crontab entries running arbitrary shell commands on a
  schedule, via `execSync` (`src/tools/cron.ts`). A scheduled job created this way
  persists after the Aura session ends.
- `telegram`, `whatsapp` — can send messages through whatever bot/session is
  configured
- `browser` — can navigate, click, type, and execute arbitrary `page.evaluate()`
  JavaScript in a real Chromium instance
- `http_request` — can make arbitrary outbound HTTP calls
- `mcp` — can call any tool exposed by a connected MCP server
- `calendar`, `memory`, `clipboard`, `notify`, `image_read`, `audio_transcribe`,
  `youtube_transcript`, `spawn_task` — lower-risk, but also unconfirmed

This isn't a deliberate trust ranking — it's what the permission check in
`src/safety/permissions.ts` actually special-cases versus what falls through to
the default `{ allowed: true }`. If you're running tasks where an unconfirmed
`email` send or a persistent `cron` job would be a problem, use `read-only` mode
for exploration and only step up to `normal` once you trust the specific task, or
avoid connecting `email`/`cron`/`telegram` for agents you don't fully supervise.

#### Shell command blocking

Independent of permission level, `run_shell` always rejects commands matching
`DANGEROUS_PATTERNS` (`src/config/defaults.ts`) — `rm -rf`, `mkfs`, `dd if=`,
fork bombs, `curl | sh` / `wget | sh`, `chmod 777`, `chown root`, `shutdown`,
`reboot`, and a few others. This list is necessarily incomplete; it catches
common destructive patterns, not all of them. It is not a substitute for running
Aura as a non-privileged user.

`find -r`, `grep -r`, and `rg` are additionally checked against project-root and
FUSE/network-mount boundaries (`ShellCommandValidator` in `src/safety/permissions.ts`)
to stop recursive searches from wandering outside your project or hanging on
unresponsive network mounts. This is a correctness/reliability guard more than a
security one — it doesn't stop a non-recursive command from reading or writing
anywhere on disk the OS user has access to.

### Where secrets live

| Secret | Location | Permissions |
|---|---|---|
| LLM provider API key | `~/.config/aura-code/provider.json` (or `$XDG_CONFIG_HOME/aura-code/provider.json`) | `0o600` |
| Gmail OAuth token | `~/.hermes/google_token.json` | `0o600` |
| Gmail OAuth setup-in-progress state | `~/.hermes/.gmail_setup_state.json` | `0o600`, deleted on completion or failure |

The Gmail `setup`/`setup_finish` flow is designed so that `client_secret` and the
issued token are never echoed back into the conversation — they're written
straight to disk and the tool's text response only ever confirms success/failure
(`src/tools/gmail-tool.ts`). The `.hermes` path is a naming leftover from an
earlier project, not a deliberate `aura-code` choice; it is not currently
configurable.

If you set an API key via `--api-key` on the command line or `:apikey` in the REPL,
it's kept in the process environment for that session and is **not** written to
disk unless you also run the `:provider` setup wizard, which saves it to
`provider.json` as above.

### What's NOT protected against

Being direct about the gaps rather than implying coverage that doesn't exist:

- **No sandboxing or containerization.** Aura runs as a normal child process tree
  on your machine. If you want isolation, run it inside a container or VM yourself
  — nothing in `aura-code` does this for you.
- **No network egress restriction.** Any tool that makes HTTP calls (`http_request`,
  `web_fetch`, `browser`, the LLM provider connection itself) can reach anywhere
  your machine can reach. There's no allowlist/denylist for outbound destinations.
- **No audit log.** Tool calls are printed to the terminal as they happen
  (and recorded in episode/dream data for `:dream`/`:rem`), but there's no
  persistent, tamper-evident security log of what was executed, when, and with
  what arguments.
- **The dangerous-command blocklist is pattern-based, not exhaustive.** It catches
  well-known destructive one-liners, not every way to cause damage from a shell.
  Don't treat `normal` mode as a safety net against a genuinely adversarial prompt
  — treat it as a guard against routine mistakes.
- **MCP servers are trusted once connected.** If you connect an MCP server, its
  tools run with the same lack of confirmation as Aura's built-in low-risk tools.
  Only connect MCP servers you trust.

### Practical recommendations

- **Use `read-only` mode** when exploring an unfamiliar codebase or task, and only
  switch to `normal` once you've seen what the agent intends to do.
- **Don't use `:approve all`** on a machine or repo you can't afford to have
  modified without review. It removes confirmation for `run_shell` and file writes
  too, not just the already-unconfirmed tools above.
- **Be deliberate about which integrations are configured.** `email`, `cron`,
  `telegram`, and `whatsapp` are powerful, unconfirmed-by-default capabilities —
  only set up the credentials/tokens for ones you actually want the agent able to
  use without asking.
- **Run as a non-privileged user.** Since there's no sandbox, your OS user account
  is the real security boundary. Don't run `aura` as root.
- **Review `git diff` after agent sessions**, especially ones run in `normal` or
  `auto` mode across many turns — the per-file write confirmation in `normal` mode
  is real, but it's easy to rapid-fire "yes" through a long session without reading
  each change closely.
