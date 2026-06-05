<p align="center">
  <img src="assets/ruby-diamond.jpg" width="280" alt="Ruby Diamond Technologies" />
</p>

<h1 align="center">ruby-code</h1>

<p align="center">
  <em>A model-agnostic AI coding agent that learns your codebase and improves itself.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-522%20passing-5a9e6e?style=flat-square" />
  <img src="https://img.shields.io/badge/TypeScript-strict-cc785c?style=flat-square&logo=typescript" />
  <img src="https://img.shields.io/badge/models-Claude%20%7C%20GPT%20%7C%20Gemini%20%7C%20MiMo%20%7C%20Ollama-8b1a2e?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-4e3d30?style=flat-square" />
</p>

---

## What it is

Ruby Code is a coding agent you point at any codebase and talk to in plain English. It reads files, writes code, runs tests, searches the codebase, and executes shell commands.

What makes it different from every other coding agent:

**It gets smarter the more you use it.**

Every task execution is captured as an episode. When a small local model struggles and a large model intervenes, the episode becomes training data. The small model is fine-tuned on the failure. Over time it handles more autonomously — getting faster, cheaper, and more specialized to your specific codebase.

---

## Proven facts

- **522 tests. Zero failures. Zero flaky tests.** 34 test files. Every module tested before or alongside implementation.
- **It reviewed its own code and found 15 real bugs.** Including a race condition in parallel memory writes and broken barrel exports that would crash at runtime. Found in 23 tool calls without being told where to look.
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
ruby-code "fix the authentication bug"
ruby-code -m mimo-v2.5-pro "refactor the payment module"
ruby-code -m ollama/qwen2.5-coder "explain this codebase"

# Multi-agent orchestration
ruby-code --orchestrate "add error handling to all API endpoints"
ruby-code --plan "refactor the database layer"   # preview plan first

# Web client (browser UI)
ruby-code serve -m mimo-v2.5-pro

# Interactive REPL
ruby-code --interactive

# Read-only (safe for exploration)
ruby-code --readonly "map the architecture"

# Point at any project
ruby-code --cwd ~/myproject "review the auth module"
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
ruby-code --models   # list all known models
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
Month 1: Ruby handles 60% of tasks autonomously
         Faster. Cheaper. Specialized to your codebase.
         ↓
         Fine-tune again. Ruby handles 80%.
```

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

- **ruby-code** — this CLI agent
- **Ruby Diamond Desktop** — native desktop app (Tauri + React, coming)
- **Harness Ready** — AI literacy course that teaches the harness concept
- **Ruby Learning Platform** — where learners interact with Ruby directly

---

<p align="center">
  Built by <a href="https://leanprogressiq.com">Lean Progress IQ</a>
</p>
