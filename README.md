<p align="center">
  <img src="./README-hero.jpg" alt="Aura">
</p>


<h1 align="center">Aura Code — Autonomous Coding Agent</h1>

<p align="center">
  <em>I don't try. I verify.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/aura-code"><img src="https://img.shields.io/npm/v/aura-code?color=cc0000&label=npm&logo=npm" alt="npm version"></a>
  <a href="https://github.com/milodule3-debug/aura-code/actions/workflows/ci.yml"><img src="https://github.com/milodule3-debug/aura-code/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-1035%2B-brightgreen" alt="1035+ tests">
  <a href="https://github.com/milodule3-debug/aura-code/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node.js 18+">
  <a href="https://github.com/milodule3-debug/aura-code"><img src="https://img.shields.io/github/stars/milodule3-debug/aura-code?style=social" alt="GitHub Stars"></a>
</p>

<p align="center">
  <a href="./docs/ARCHITECTURE.md">
    <img src="./assets/architecture-diagram.png" alt="Architecture Diagram" width="800">
  </a>
  <br>
  <em><a href="./docs/ARCHITECTURE.md">View full architecture documentation →</a></em>
</p>

<p align="center">
  <img src="./assets/demo.gif" alt="Aura Code CLI Demo" width="800">
  <br>
  <em>CLI demo — help, models, and version overview</em>
</p>

---

## What is Aura Code?

Aura Code was developed using AI-assisted engineering workflows, with multiple AI agents contributing to design, implementation, testing, and verification. Written in TypeScript — not related to the Ruby programming language.

Built on the **Praktess** framework — from Ancient Greek: *she who acts and executes*.

---

## Quick Start

```bash
npm install -g aura-code
aura 'your task here'
```

Set at least one API key before running:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # Claude
export OPENAI_API_KEY="sk-..."          # GPT
export GOOGLE_API_KEY="..."             # Gemini
export XIAOMI_API_KEY="tp-..."          # MiMo
# Local — no API key needed:
# ollama pull qwen2.5-coder:1.5b
```

---

## What Aura Does

1. **Reads** your codebase — files, structure, dependencies
2. **Plans** a strategy — decides what to change and how
3. **Executes** — writes code, runs commands, makes edits
4. **Verifies** — runs tests, checks file integrity, confirms changes
5. **Reports** — summarizes what was done and what passed

---

## Modes

| Mode | What it does |
|------|-------------|
| `normal` | Single-agent loop: read → plan → execute → verify |
| `orchestrate` | Multi-agent: Researcher → Coder → Reviewer |
| `architect` | High-level design and planning before implementation |
| `verify` | Post-task checks with automatic retry on failure |
| `analyze` | Scan session history for failure patterns |

```bash
aura 'fix the bug'                                      # normal
aura --orchestrate 'add error handling to all endpoints' # orchestrate
aura --architect 'design the new auth system'            # architect
aura --verify --test-command "npm test" 'fix the tests'  # verify
aura --analyze                                           # analyze
```

---

## Providers

| Provider | Models |
|----------|--------|
| **Claude** (Anthropic) | Opus, Sonnet, Haiku |
| **GPT** (OpenAI) | gpt-4o, gpt-4o-mini |
| **Gemini** (Google) | gemini-2.5-pro, gemini-2.5-flash |
| **MiMo** (Xiaomi) | mimo-v2.5-pro, mimo-v2.5 |
| **DeepSeek** (OpenRouter) | deepseek-v4-pro, deepseek-v4-flash:free |
| **Ollama** (Local) | Any local model — no API key needed |

Any OpenAI-compatible endpoint also works via `openrouter/<model>`.

---

## Testing

```bash
npm install
npm run build      # compiles TypeScript, zero errors expected
npm test           # runs the full suite (vitest)
```

For local development:

```bash
npm run test:watch     # re-runs tests on file changes
npm run test:coverage  # generates a coverage report
```

The suite currently runs 1000+ tests across 60+ files, covering the agent
loop, all provider integrations, the tool registry, safety/permissions, the
orchestration and self-improvement layers, and the dashboard generator.

Contributions should keep `npm run build` and `npm test` clean before
opening a pull request.

---

## Known Limitations

- **Self-improvement routing (RubyAlternator) is implemented but inactive.**
  Episode recording and competence scoring both work and are visible in the
  dashboard's Learning tab, but the routing logic that would actually use
  competence scores to pick models isn't wired into the main agent loop yet.
  Today, model selection doesn't change based on what Aura has learned.

- **Provider behavior varies by model.** Tool-calling support, context
  window handling, and error message quality differ across providers —
  some of this is normalized (see CHANGELOG for cross-provider config
  fixes), but not all of it. If a model behaves unexpectedly with tools,
  check whether the provider documents function-calling support before
  assuming it's a bug in Aura.

- **Large refactors still need verification.** `--verify` and `--test-command`
  catch regressions Aura's own changes introduce, but they don't replace
  review for changes spanning many files or with subtle behavioral intent.

- **Conversation compaction is new.** Long sessions now auto-summarize older
  turns to stay within context limits; this is recently added and still
  being hardened against edge cases in unusual tool-call sequences.

---

## Stats

| Metric | Value |
|--------|-------|
| Tests | 1035+ passing, 0 failures |
| Version | v0.3.7 |
| Language | TypeScript (strict) |
| License | MIT |

---

## Repository

GitHub: https://github.com/milodule3-debug/aura-code
(Repo renamed from milodule3-debug/rubyness — existing clone URLs redirect automatically)

---

## Links

- [Lean Progress IQ](https://lean-progress-iq-site.vercel.app)
- [Aura Manifesto](her-rubyness-manifesto.html)

---

<p align="center">
  Built by <a href="https://lean-progress-iq-site.vercel.app">Lean Progress IQ</a>
</p>
