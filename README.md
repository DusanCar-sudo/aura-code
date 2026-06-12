<p align="center">
  <img src="assets/ruby-diamond.jpg" width="280" alt="Ruby Diamond Technologies" />
</p>

<h1 align="center">BootstrapRuby</h1>

<p align="center">
  <em>An AI coding agent built entirely by AI agents. I acted as the orchestrator — directing Claude, OpenCode, Pi, and Grok to design, implement, test, and verify it. The agent that writes your code was itself written by agents.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-566%20passing-5a9e6e?style=flat-square" />
  <img src="https://img.shields.io/badge/TypeScript-strict-cc785c?style=flat-square&logo=typescript" />
  <img src="https://img.shields.io/badge/models-Claude%20%7C%20GPT%20%7C%20Gemini%20%7C%20MiMo%20%7C%20Ollama-8b1a2e?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-4e3d30?style=flat-square" />
</p>

---

## Why This Exists

BootstrapRuby is an open-source autonomous coding agent inspired by Claude Code, OpenHands, and modern multi-agent research. Its goal: combine agent orchestration, persistent memory, provider independence, and self-improvement experimentation into a single extensible platform. Written in TypeScript — not related to the Ruby programming language.

---

## Architecture

```
                           ┌─────────────────────────────────────────────────────────┐
                           │                    LLM Providers                         │
                           │   Claude  │  GPT  │  Gemini  │  MiMo  │  Ollama         │
                           └────────────────────────┬────────────────────────────────┘
                                                    │
                           ┌────────────────────────▼────────────────────────────────┐
                           │                  Knowledge Graph                         │
                           │          (141 nodes, 142 edges — auto-extracted)         │
                           └────────────────────────┬────────────────────────────────┘
                                                    │
                           ┌────────────────────────▼────────────────────────────────┐
                           │                  Memory Layer                            │
                           │   sessions  │  episodes  │  competence map              │
                           └────────────────────────┬────────────────────────────────┘
                                                    │
                    ┌───────────────────────────────▼────────────────────────────────┐
                    │                                                                │
          ┌─────────▼──────────┐                                        ┌────────────▼────────────┐
          │    Single Agent     │                                        │      Orchestrator        │
          │       Loop          │                                        │    (multi-agent mode)    │
          │                     │                                        │                          │
          │  Read → Plan →      │                                        │  Researcher → Coder →    │
          │  Execute → Verify   │                                        │  Reviewer                │
          └─────────┬──────────┘                                        └────────────┬────────────┘
                    │                                                                │
                    └───────────────────────────────┬────────────────────────────────┘
                                                    │
                           ┌────────────────────────▼────────────────────────────────┐
                           │                      Router                             │
                           │            (decides single vs. orchestration)            │
                           └────────────────────────┬────────────────────────────────┘
                                                    │
                           ┌────────────────────────▼────────────────────────────────┐
                           │                       CLI                               │
                           │        bootstrapruby "fix the authentication bug"           │
                           └─────────────────────────────────────────────────────────┘
```

---

## What it is

BootstrapRuby is a coding agent you point at any codebase and talk to in plain English. It reads files, writes code, runs tests, searches the codebase, and executes shell commands.

---

## Evidence

- **Test suite: 566 passing tests across 35 files** (last run: 2026-06-08). Coverage: 87% orchestration, 92% utilities, 62% overall.
- **In a single recorded session (2026-06-06), the agent reviewed its own orchestration layer and identified 15 bugs (2 critical)**, documented by severity with file locations. This was one demonstration, not a benchmark.
- **It fixed a Python project it had never seen.** Read 545 lines of Python, extracted a shared utility, added file locking, added semantic relevance validation, wrote 14 new tests, left 92 tests passing.
- **Knowledge graph: 141 nodes, 142 edges** extracted from its own architecture automatically.
- **Runs on Xiaomi MiMo at 1/7 the cost of Claude Opus.** Model-agnostic means cost-agnostic.

---

## Install

```bash
git clone https://github.com/milodule3-debug/ruby-code
cd ruby-code
npm install
npm run build
npm link
```

Set at least one API key:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # Claude
export XIAOMI_API_KEY="tp-..."          # MiMo (cheapest, recommended)
export OPENAI_API_KEY="sk-..."          # GPT
export GOOGLE_API_KEY="..."             # Gemini
export OPENROUTER_API_KEY="sk-or-..."   # All models via one key
# Local — no API key needed:
# ollama pull qwen2.5-coder:1.5b
```

---

## Usage

```bash
# Single task
bootstrapruby "fix the authentication bug"
bootstrapruby -m mimo-v2.5-pro "refactor the payment module"
bootstrapruby -m ollama/qwen2.5-coder "explain this codebase"

# Multi-agent orchestration
bootstrapruby --orchestrate "add error handling to all API endpoints"
bootstrapruby --plan "refactor the database layer"   # preview plan first

# Verification with automatic retry
bootstrapruby --verify --test-command "npm test" "add error handling to the auth module"
bootstrapruby --verify --max-verify-retries 5 "fix flaky test suite"

# Web client (browser UI)
bootstrapruby serve -m mimo-v2.5-pro

# Interactive REPL
bootstrapruby --interactive

# Read-only (safe for exploration)
bootstrapruby --readonly "map the architecture"

# Point at any project
bootstrapruby --cwd ~/myproject "review the auth module"
```

---

## Supported models

| Model | Provider | Speed | Notes |
|-------|----------|-------|-------|
| `mimo-v2.5-pro` | Xiaomi MiMo | Fast | Recommended. 1T params, 1/7 cost of Opus |
| `mimo-v2.5` | Xiaomi MiMo | Fastest | 310B |
| `claude-opus-4-5-20251001` | Anthropic | Powerful | Best reasoning |
| `claude-sonnet-4-5-20251001` | Anthropic | Fast | Good balance |
| `gpt-4o` | OpenAI | Fast | — |
| `gemini-2.5-pro` | Google | Powerful | 1M context |
| `grok-beta` | xAI | Fast | — |
| `ollama/qwen2.5-coder` | Local | No API key | Runs on your machine |
| `ollama/llama3.2` | Local | No API key | General purpose |
| `openrouter/<any>` | OpenRouter | Varies | 100+ models |

```bash
bootstrapruby --models   # list all known models
```

---

## How it works

### Single agent mode
```
Task → Read context → Plan → Execute tools → Verify → Done
```

### Multi-agent orchestration
```
Task → Router decides complexity
     ↓
     Orchestrator builds ExecutionPlan (3-5 steps)
     ↓
     Knowledge graph informs all decisions
     ↓
     Researcher → reads codebase (never writes)
     Coder      → implements changes (full tool access)
     Reviewer   → validates correctness (never writes)
     ↓
     Steps run in parallel where possible
     ↓
     Results synthesised into coherent outcome
```

### The Ruby Principle
```
Day 1:   Large model handles everything
         ↓
         Every task captured as an episode
         ↓
Week 2:  Small model (Ruby) attempts tasks first
         When Ruby struggles → large model intervenes
         Episode captured: "Ruby failed here, large model did this"
         ↓
         Fine-tuning run on failure episodes
         ↓
Target:  Small model handles majority of routine tasks after fine-tuning.
         Not yet measured — fine-tuning loop infrastructure is built but
         the full cycle has not been completed.
```

Ruby records execution episodes and generates JSONL datasets for fine-tuning experiments. The capture and export pipeline is tested; the full train-evaluate-improve cycle is future work.

---

## Verification Layer

The `--verify` flag (new in v0.2.0) runs post-task checks and retries automatically when verification fails.

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--verify` | off | Enable post-task verification with automatic retries |
| `--max-verify-retries N` | 3 | Maximum number of retry attempts after verification failure |
| `--test-command <cmd>` | — | Shell command to run as part of verification (e.g. `"npm test"`) |
| `--profile local` | — | Use local Ollama model (no API key required) |

### What it checks

- **file exists** — written files actually exist on disk with minimum 100 bytes
- **file mtime** — edited files have been modified since the task started
- **tests pass** — `--test-command` exits successfully (ignores pre-existing failures by establishing a baseline before the task runs)
- **shell test** — re-runs any test commands the agent itself invoked during execution
- **files created** — if the task intent contains "create"/"add"/"write" and no `write_file` calls were made, checks that new files appeared in the project

### Example output

```
═══ Attempt 1/3 ═══  "add error handling to the auth module"
  → Agent runs: reads files, edits code, runs shell commands
  → Verification runs:
    ✓ file exists:  src/auth/handler.ts — 847 bytes
    ✓ file mtime:   src/auth/handler.ts — modified
    ✗ tests pass:   1 new test failure(s): tests/auth.test.ts

  ⚠ Verification failed (attempt 1/3)
    tests pass: 1 new test failure(s): tests/auth.test.ts

═══ Attempt 2/3 ═══
  → Agent retries with context: "Previous attempt failed: tests pass: 1 new test failure(s)"
  → Fixes the test, re-runs verification
  ✓ Verification passed on attempt 2
```

### Baseline diff

When `--test-command` is set, BootstrapRuby captures pre-existing test failures before the task starts. Only **new** failures introduced by the task cause verification to fail. Pre-existing failures are reported but do not block.

---

## Features

### What Works Today

- **Multi-provider routing** — automatic model selection across Claude, GPT, Gemini, MiMo, Ollama, and any OpenAI-compatible endpoint
- **Orchestration** — multi-agent execution with Researcher/Coder/Reviewer specialists, parallel where possible
- **Knowledge graph extraction** — automatic architecture, dependency, and constraint mapping (141 nodes, 142 edges extracted from this project)
- **Session persistence** — conversation history across CLI sessions, resumable with `--resume`
- **Verification layer** — post-task checks with automatic retry (`--verify`, `--test-command`, `--max-verify-retries`)
- **Episode capture** — every task execution recorded as input/output/success-failure for training data
- **Resilience stack** — exponential backoff with jitter, circuit breaker after 5 consecutive failures, automatic failover to fallback models, rate limiting (RPM/TPM)
- **Safety system** — permission levels per tool type, `--readonly` mode, `--auto` for unattended runs
- **First-run wizard** — guided setup for API keys, model selection, and provider configuration

### Experimental

- **Ruby Principle alternation** — small model attempts first, large model intervenes on failure. Infrastructure built; full cycle not yet completed end-to-end.
- **Fine-tuning data export** — JSONL dataset generation from episodes. Tested; actual training runs are future work.
- **Competence mapping** — per-task-pattern success rate derived from episodes. Data structure exists; meaningful measurement requires sustained usage.

### Roadmap

- **Automated fine-tuning cycle** — train → evaluate → deploy → measure improvement loop
- **Competence gain measurement** — quantitative tracking of small model improvement over time
- **Ruby Diamond Desktop** — native desktop app (Tauri + React)

---

## Memory system

| Layer | What it stores | Where |
|-------|---------------|-------|
| Knowledge graph | Architecture, dependencies, constraints, trajectory | `.rubycode/perception.json` |
| Orchestration memory | Step results shared between specialists | `.rubycode/memory.json` |
| Session store | Conversation history across CLI sessions | `~/.rubycode/sessions/` |
| Episode store | Every task execution — input, output, success/failure | `~/.rubycode/episodes/` |
| Competence map | Ruby's success rate per task pattern | Derived from episodes |

---

## Tools available

| Tool | What it does |
|------|-------------|
| `read_file` | Read any file with optional line range |
| `list_dir` | Directory tree, respects .gitignore |
| `edit_file` | Targeted find-and-replace (3-tier fuzzy matching) |
| `write_file` | Create or overwrite files |
| `search_code` | Ripgrep/grep across the codebase |
| `run_shell` | Execute shell commands |
| `run_tests` | Auto-detect and run test suite |
| `git_status` | Current git state |
| `git_diff` | File diffs |
| `spawn_task` | Spawn sub-agents for parallel work |

---

## Project config

Add `.rubycode.json` to any project:

```json
{
  "model": "mimo-v2.5-pro",
  "mode": "normal",
  "ignore": ["dist/", "*.generated.ts"]
}
```

---

## Part of the Ruby Diamond ecosystem

- **BootstrapRuby** — this CLI agent
- **Ruby Diamond Desktop** — native desktop app (Tauri + React, coming)
- **AgentMesh WF** — agent workflow framework
- **AgentMesh** — multi-agent coordination platform

---

<p align="center">
  Built by <a href="https://leanprogressiq.com">Lean Progress IQ</a>
</p>
