# Security model

Aura is an autonomous coding agent. When you run `aura`, tool calls execute
with **your full user privileges** — there is no OS sandbox. The agent also
reads untrusted content (repo files, fetched web pages, command output) and
feeds it to the model, so a **prompt-injection payload in that content can
attempt to drive tool calls**. The layers below exist to keep that from
escalating into arbitrary code execution, secret theft, or a networked
foothold.

These are defense-in-depth mitigations, not a sandbox. For untrusted code,
run Aura inside a container/VM you're willing to lose.

## What's enforced (v0.7.2)

### Filesystem jail — file tools stay inside the project root
`read_file`, `write_file`, `edit_file`, `list_dir`, `search_code`, and the
`run_shell` working directory all resolve their target through
`src/safety/path-jail.ts` and reject anything outside the project root:
`../` traversal, absolute paths (`/etc/passwd`, `~/.ssh/...`), and **symlink
escapes** (a symlink inside the project that points outside is resolved before
the containment check). This blocks reading credentials into model context and
writing persistence into shell rc files / `authorized_keys`.

> Note: `run_shell` itself is not filesystem-contained — a shell command can
> still `cat` anything the user can. The jail covers the structured file tools;
> shell is gated by the permission layer below.

### SSRF guard — outbound HTTP can't reach internal targets
`web_fetch` and `http_request` route through `src/safety/ssrf.ts`, which:
- allows **http/https only**;
- **resolves the host and rejects** loopback, RFC-1918, link-local
  (incl. the `169.254.169.254` cloud-metadata endpoint), CGNAT, and IPv6
  loopback/ULA/link-local/mapped-private addresses;
- **re-validates every redirect hop** (redirects are followed manually), so a
  public URL can't 302 to the metadata service.

This closes the "steal cloud IAM creds / hit an internal admin panel and
exfil" chain from the outbound tools.

### Command permissions — interpreters require confirmation
`src/safety/permissions.ts` + `src/config/defaults.ts`:
- The auto-approve **safe-list no longer contains interpreters or
  package-runners** (`node`, `python`, `python3`, `ts-node`, `npx`,
  `npm run`, `curl`). Whitelisting an interpreter is equivalent to
  whitelisting "run any code" (`node -e '…'`, `python3 -c '…'`), so these now
  require explicit confirmation in `normal` mode.
- A command is only auto-approved if it has **no shell control operators**
  (`;`, `&`, `|`, `<`, `>`, backtick, `$(`). This stops prefix-smuggling like
  `cat x; python3 -c '…'` — a safe prefix can no longer launder a chained
  command.
- The safe-list match is **anchored** to the whole command, so `lscpu` no
  longer matches `ls`, `curlx` no longer matches `curl`.
- The dangerous-command denylist is broadened (long-form `rm --recursive
  --force`, `find … -delete/-exec`, world-writable `chmod`). **This denylist
  is a backstop only** — a regex over a shell string can always be evaded, so
  it is never the primary boundary. The primary boundary is: interpreters
  need confirmation, and `--auto` mode is an explicit user opt-in to skip it.

### Web server — loopback + token + origin
`src/server/index.ts` (the `aura --serve` web client):
- **binds `127.0.0.1`** (not `0.0.0.0`), so it isn't LAN-reachable;
- requires a **per-session bearer token** (random 24 bytes, or
  `AURA_SERVER_TOKEN`) on every HTTP route and on the WebSocket handshake —
  the token is embedded in the served page URL;
- **validates the WebSocket `Origin`** against its own origin, blocking
  cross-site WebSocket hijacking (a random website you visit can't open
  `ws://localhost:<port>` and drive your agent).

## Still open / by design
- **No OS sandbox.** `run_shell` and test-runners execute real code with your
  privileges. Confirmation gates it in `normal` mode; `--auto` skips
  confirmation by design.
- **`--auto` mode** relies on the denylist backstop. Use it only in a
  disposable environment.
- **No audit log** of executed commands, and no outbound egress allow-list.
- Test-runners (`npm test`, `pytest`, …) remain auto-approved for workflow
  reasons; a malicious repo's test script is a separate threat (running an
  untrusted project's tests). Prefer a container for untrusted repos.
