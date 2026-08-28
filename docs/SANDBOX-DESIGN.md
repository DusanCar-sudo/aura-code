# `--sandboxed`: a real boundary

**Status:** implemented (Linux/bubblewrap), `src/safety/sandbox.ts`, verified by
`tests/safety/sandbox-boundary.test.ts`. The open questions at the bottom are
answered in "Decisions taken" below; the rest of this document is the design as
approved, kept for the reasoning behind the options that were rejected.

## The problem, stated exactly

SECURITY.md:164 already says it, correctly:

> The check is ordinary TypeScript in a tree Aura can write to, and this has
> been demonstrated rather than theorised — asked firmly enough to enable
> computer use "even if you need to change files", Aura edited its way past the
> gate. The same is true of every other in-process guard here, including the
> permission levels: an agent that can edit its own source and rebuild can edit
> the thing that says no.

Three guards live in this repo, all of them ordinary TypeScript running in the
same process, with the same UID, as the agent they constrain:

| Guard | File | What it stops |
|---|---|---|
| Permission levels | `src/safety/permissions.ts` | unconfirmed writes / shell |
| Path jail | `src/safety/path-jail.ts` | file tools escaping the project root |
| Computer-use gate | `src/tools/screen/disclosure.ts` | screen/input control |

`run_shell` and `write_file` are enough to edit any of them. The guards stop
accidents. They are not boundaries, and the project is unusually honest about
saying so — which is precisely why closing the gap is worth doing rather than
papering over.

## What a boundary has to mean here

A boundary is a rule the agent's own UID cannot rescind. That rules out
anything written in TypeScript inside `dist/`.

Two guarantees are achievable and worth having:

- **G1 — the guards cannot be tampered with.** Aura's installed tree is
  read-only from inside the sandbox. Nothing a session does can change what the
  *next* session enforces.
- **G2 — the blast radius is the project.** Writes outside the project root and
  the state directory fail at the OS level, not at `path-jail.ts`. This turns an
  in-process check into an enforced one.

One guarantee is **not** achievable and must not be claimed:

- **Not G3 — "the agent cannot run arbitrary code."** `run_shell` exists by
  design. Inside the sandbox the agent can still write a script into the project
  and execute it, including spawning `node -r ./patch.js` against a *copy* of the
  engine. What it cannot do is make that modification persist into the installed
  Aura. The honest claim is "tampering cannot persist", not "the agent is
  contained".

Overclaiming here would repeat exactly the failure SECURITY.md currently avoids.

## Options considered

### A. Dedicated user account

Re-exec the engine as an `aura-sandbox` user that has no write permission on the
install directory.

- **Boundary strength:** strong. Standard POSIX ownership; nothing exotic.
- **Cost:** needs root once to create the user, and the project tree must be made
  writable by it (`chown`/ACL). That second step is the killer — every new
  project needs a permissions change, and getting it wrong either breaks the
  agent or hands the sandbox user more than intended.
- **Other friction:** interactive TTY handoff, `sudo` in the invocation path, API
  keys must cross a user boundary without landing in a world-readable env.

### B. Container mode

Run the engine in a container: project bind-mounted read-write, install
read-only.

- **Boundary strength:** strongest, and the most portable across hosts.
- **Cost:** a heavy dependency (Docker/Podman must be installed and running),
  seconds of startup per invocation, and it breaks two things this project cares
  about — **computer use** (needs the host display and input devices) and the
  **local Archimedes path** (needs to reach Ollama on the host). Both are
  solvable with `--network=host` and X11/Wayland socket passing, at which point
  a good part of the isolation is handed back.

### C. OS-level filesystem restriction — **recommended**

On Linux, `bubblewrap` (`bwrap`) creates an unprivileged user namespace and
binds the filesystem exactly as told:

```
bwrap --ro-bind / /  --dev /dev  --proc /proc   \
      --bind <project-root> <project-root>      \
      --bind <state-dir>    <state-dir>         \
      -- node <install-dir>/dist/cli/index.js "$@"
```

Note the root bind is `--ro-bind`, not `--dev-bind`. An earlier draft of this
sketch used `--dev-bind / /`, which leaves the entire filesystem writable and
delivers G1 only — the install would have needed its own `--ro-bind` and
everything else would still have been open. Read-only by default with explicit
read-write exceptions is the shape that yields both guarantees, and it fails
closed: a path nobody thought about is read-only rather than writable.

- **Boundary strength:** strong for G1 and G2. The read-only bind is enforced by
  the kernel; a write to the install tree returns `EROFS` regardless of UID.
- **Cost:** one small, widely packaged binary. **No root, no daemon, no
  per-project `chown`, no startup penalty.**
- **Keeps what matters:** the process stays on the host network and the host
  display, so Ollama and computer use continue to work unchanged.
- **Limits:** Linux only. `bwrap` needs unprivileged user namespaces enabled
  (default on most distros; Debian and RHEL have historically shipped it off).

### Verified, not assumed

Both guarantees were tested on this machine (`bwrap` present, unprivileged
userns enabled) before recommending the option:

| Attempt | Result |
|---|---|
| write a guard file in the install tree | `Read-only file system`, file byte-unchanged |
| write `authorized_keys` outside the jail | `Read-only file system`, file byte-unchanged |
| write inside the project root | succeeded |
| run `node` | works |
| reach Ollama on `localhost:11434` | `HTTP 200` |

The last two matter as much as the first two: a boundary that breaks the local
model path would invalidate the project's whole economic argument, and nobody
would run it.

### Recommendation

**Option C as the default, with B documented as the stricter opt-in.**

C buys both achievable guarantees at near-zero operational cost and without
sacrificing the local-model path — which is the whole economic argument of this
project, so a sandbox that breaks it would not get used. B stays documented for
anyone who wants isolation beyond the filesystem and will accept the cost.

A is not recommended: it delivers no more than C while requiring root and a
per-project permission change.

Platform support is explicitly staged, and stated rather than implied:

| Platform | Mechanism | Status |
|---|---|---|
| Linux | `bubblewrap` | recommended, phase 1 |
| Linux (no userns) | container mode | documented fallback |
| macOS | `sandbox-exec` | investigate; deprecated but functional |
| Windows | — | unsupported; `--sandboxed` must refuse, not pretend |

`--sandboxed` on a platform with no mechanism must **fail loudly**. A flag that
silently does nothing is worse than no flag, because it manufactures exactly the
false confidence this design exists to remove.

## Implementation sketch

1. **`src/safety/sandbox.ts`** — detect an available mechanism, build the
   `bwrap` argv, re-exec `process.argv` inside it. One module, no changes to any
   tool.
2. **Re-exec guard** — an env marker (`AURA_SANDBOX_ACTIVE=1`) so the inner
   process knows it is already jailed and does not recurse.
3. **Path set** — install dir read-only; project root read-write; `~/.aura`
   read-write (sessions, episodes, the cost ledger); everything else inherited
   read-only via `--ro-bind /`.
4. **Startup banner** — state which guarantees are active, in the same plain
   register SECURITY.md uses.
5. **Refusal path** — no mechanism, no sandbox, non-zero exit.

## How it gets verified

The plan asks for a test that attempts to modify a guard file from inside the
sandbox and asserts failure. Concretely, `tests/safety/sandbox-boundary.test.ts`,
skipped when `bwrap` is absent so it never passes vacuously:

- writing to `<install>/dist/safety/permissions.js` fails with `EROFS`/`EACCES`
- writing to `<install>/dist/tools/screen/disclosure.js` likewise
- writing *inside the project root* still succeeds — a boundary that breaks the
  agent is not a boundary, it is an outage
- writing to `$HOME/.ssh/authorized_keys` fails at the OS level, with
  `path-jail.ts` deleted from the picture — proving G2 is enforced rather than
  merely checked
- `--sandboxed` with no mechanism available exits non-zero

The third and fourth cases matter most: they are what distinguish a real
boundary from a broken install.

## SECURITY.md changes

The existing disclosure stays exactly as it is for the default path — it is
accurate and it is the reason this work is worth doing. A new section
distinguishes the two modes:

- **Default — guardrail.** Unchanged text. In-process gates, honest about
  stopping accidents rather than operators.
- **`--sandboxed` — boundary.** G1 and G2, named as guarantees, with the
  mechanism and platform stated. Plus the explicit non-guarantee: arbitrary code
  execution inside the sandbox remains possible, so this bounds blast radius and
  prevents persistent tampering — it does not make an adversarial agent safe.

## A conflict this design cannot dissolve

In a **development checkout the install directory *is* the project root** — on
this machine `which aura` resolves to `<repo>/dist/cli/index.js`. G1 wants that
tree read-only; G2 wants the project writable. Both cannot hold at once.

This is not a flaw in the mechanism, it is the honest shape of the situation:
when the agent's task is editing Aura itself, no filesystem boundary can
distinguish "legitimate work" from "editing the thing that says no". Options:

- **Refuse.** `--sandboxed` errors when the project root contains the running
  install. Cleanest, and states the truth.
- **Split.** Sandbox against an installed copy elsewhere, so the checkout is
  editable but the *running* engine is not. More useful, more moving parts.

I lean toward refusing in phase 1 and documenting why, because a sandbox that
appears to work while the agent edits its own guards is worse than no sandbox.
Note this means `--sandboxed` will not protect work *on this repo* — it protects
users running Aura against other projects, which is the actual deployment.

## Decisions taken

1. **`~/.aura` is inside the boundary; config is not.** State and config already
   live in different directories — state in `~/.aura`, config in
   `~/.config/aura-code/` — so the split the question asked for costs nothing.
   State is bound read-write; the config file stays read-only, and with it the
   default permission level it can carry. A session cannot weaken the next one.

2. **`--sandboxed` stays opt-in for now.** Making it the default is the change
   that would actually move users' security posture, but it is a separate
   decision from shipping the mechanism, and it wants real-world use first.

3. **Computer use is refused under `--sandboxed`.** The two are mutually
   exclusive: the CLI refuses the combination at startup, and
   `checkComputerUseGate` refuses inside a sandbox so `:compon` cannot lift it
   mid-session. Host display access is a genuine escape route from a filesystem
   boundary, and a guarantee with a documented way around it is not one.

## What the implementation found that the design did not

**A private `/tmp`, mounted first.** The design's path set named the install,
the project and the state dir. It did not mention `/tmp`, and the first
implementation bound the host's one read-write so builds would keep working —
which quietly punched a hole through G2, since `/tmp` is outside the project and
world-readable. The boundary test caught it by *succeeding* at a write it was
supposed to be refused. It is now `--tmpfs`: private, writable, gone when the
sandbox exits.

Then the ordering bit. bwrap applies its arguments left to right, so a tmpfs
mounted after the project bind mounts straight over it — a project at
`/tmp/my-app` appeared inside the sandbox as an empty directory, with no error
anywhere. The tmpfs now comes first and the writable binds land on top. Both
behaviours are pinned by tests, because both failed silently, which is the
failure mode this whole document exists to argue against.

## Open questions, as originally written

1. **Is `~/.aura` inside or outside the boundary?** It must be writable
   (sessions, episodes, cost ledger). But `~/.aura/config.json` can carry a
   default permission level, so a writable state dir is a small channel for
   persisting a weakened setting. Options: split writable state from read-only
   config, or accept it and document it. My inclination is to split, since the
   whole point is that nothing a session does changes what the next one enforces.
2. **Should `--sandboxed` become the default** once Linux support is solid,
   with an explicit `--no-sandbox` escape? That is the choice that would actually
   change users' security posture, rather than offering a flag almost nobody
   types.
3. **Does computer use stay permitted under `--sandboxed`?** Host display access
   is a real escape route from a filesystem sandbox — a process that can drive
   the user's keyboard can open a terminal outside the jail. Arguably
   `--sandboxed` should refuse computer use outright, and the two flags should be
   mutually exclusive.

Question 3 is the one I would most want settled before writing code, because it
decides whether `--sandboxed` is a filesystem boundary or a broader one.
