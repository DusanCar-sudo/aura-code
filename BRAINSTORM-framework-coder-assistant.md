# Brainstorm: Aura as a framework + a coder assistant with one memory for all

*2026-09-01 — written while Dusan is out, per request to brainstorm and email.*

The idea in one line: turn Aura's agent runtime into a framework, and ship the
coder personal assistant as its flagship app — with one persistent memory that
every surface (CLI, web, Telegram, swarm agents) shares.

## You already have 80% of the framework

Aura today has: a provider abstraction (multi-provider, per-agent model
pickers), a swarm orchestrator, a kanban task board, perception, computer use,
plugins/skills, and two memory layers — episodic memory (append-only JSONL with
search, `src/agent/episodic-memory.ts`) and a fact KV store
(`src/tools/memory.ts`). That IS a framework; it just isn't packaged as one.

The move isn't a rewrite, it's drawing the seams: the framework is
"harness + providers + memory + surfaces", and apps are configurations of it.

## Aura Coder — the flagship app on the Aura framework

Aura Coder is the coding assistant that ships on top of the framework. The
framework owns "harness + providers + memory + surfaces"; Aura Coder is a
configuration of it — a system prompt, a tool set (file edit, shell, search,
tests), the verification gate, and the memory wiring below.

Its core is one agent loop (`src/agent/loop.ts`, `runAgentLoop`) — the same
four steps Claude Code runs, to the letter. Everything else in that file is
hardening around them.

1. **Read** the message + context — repo state, recalled memory notes, prior
   tool results. (`buildSystemPrompt` + `initialHistory` + the task; per turn,
   drain mid-run steering and compact history if it outgrew the window.)
2. **Think, then act** — stream one model response; call a tool (read/edit
   files, run bash, run tests, search).
3. **Observe and adjust** — read each tool result into history, correct
   course, repeat from 2. Stall detection, the "described the work instead of
   doing it" nudge, and empty-response retry all live here.
4. **Stop when done and verified**, then reply. (`stopReason === 'done'` →
   persist + return; verification is the `runWithVerification` wrapper that
   re-runs the loop against failing tests.)

Turn-based: each user message starts a fresh cycle but carries the full
history; when history gets long it is compacted so the loop continues without
losing the thread. The loop does not run in the background — it acts on a
message, or when a spawned subagent / scheduled job reports back. The
cumulative guards (`maxTurns` per call, `SessionBudget` across a conversation)
only decide when to stop early — they don't change the loop's shape.

What the framework should expose so other apps get this loop for free: the
loop itself (pluggable tools + system prompt), the provider abstraction, the
verification wrapper, the session store, and the memory door (below).

## Sequencing: build the app, extract the framework

Don't framework-ize first. Framework-first projects die in abstraction.
Instead: build the coder assistant as a real app, and every time you feel the
urge to special-case it, promote that piece into the framework. The coder
assistant becomes the proof that the framework is real. (Same play as
Remotion/Next: app first, framework extracted from it.)

## The coder personal assistant

A persistent coder companion that sits on the Aura harness and remembers
across sessions and machines:

- **Per-project memory**: decisions taken, bugs fixed and how, renamed things,
  "don't touch this", why the CI is red. This is where the bench-tier-question
  backlog problem would have solved itself — the assistant would have
  remembered the questions referenced renamed code.
- **Global memory**: your preferences, your standard release flow (the 0.0.5
  cadence), your ship-clean-then-debug policy — learned, not configured.
- **Surfacing**: before starting a task it recalls relevant history; after
  finishing it writes back a compact episode. Swarm agents inherit project
  memory read-only, and write findings back through the same door.
- **Recall is search, not lookup** — the episodic design already got this
  right ("you do not remember the key").

## Single persistent memory for all — the hard part

One store, layered by scope: user (global) > project (per-repo) >
surface/session (ephemeral). Rules worth settling early:

1. **Identity is the person, not the surface.** A memo from Telegram and a
   decision from a web session land in the same store, tagged with origin.
2. **Write through one door.** Every surface goes through one memory API so
   scoping, dedup and secret-filtering are enforced once.
3. **Secrets never enter memory.** Live tokens already persisted into
   `~/.aura/sessions` once. The memory write path needs redaction — better:
   refuse-and-flag at write time.
4. **Consolidation.** Raw episodes grow forever; a periodic pass (the `dream`
   module feels like the natural home) distills episodes into settled facts
   and prunes the noise. Episodic = the journal; facts = the summary.
5. **Conflict policy**: newest wins per scope, but project beats user for
   project-specific facts, and contradictions are surfaced, not silently
   overwritten.

## Why this is the right next move

Everything else built so far — phone pairing, Telegram bots, computer use,
swarm — is surfaces. The memory layer is the thing that makes those surfaces
feel like ONE assistant instead of five tools. It's also the moat: model
access is a commodity; a coder assistant that remembers three months of your
project history is not.

## Risks

- **Memory bloat and recall quality** — search-only recall degrades fast past
  a few thousand episodes; consolidation has to land early.
- **Privacy**: a single store is a single leak point; encrypt at rest and keep
  the redaction wall strict.
- **Scope creep into "framework"** — resist until the coder app forces the
  abstractions out.

## Suggested first step

One PR: a unified memory service (write door + scoped search) wrapping the
existing episodic + fact stores, then wire the coder assistant's task-start
hook to recall from it. That's a weekend, not a quarter.
