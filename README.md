<p align="center">
  <img src="./README-hero.jpg" alt="Aura">
</p>


<h1 align="center">Aura Code — Autonomous Coding Agent</h1>

<p align="center">
  <em>I don't try. I verify.</em>
</p>

---

## What is Aura Code?

Aura Code is an autonomous coding agent built entirely by AI agents. Claude, OpenCode, Pi, Grok, and Aura itself collaborated to design, implement, test, and verify the codebase. The agent that writes your code was itself written by agents. Written in TypeScript — not related to the Ruby programming language.

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
| **Ollama** (Local) | Any local model — no API key needed |

Any OpenAI-compatible endpoint also works via `openrouter/<model>`.

---

## Stats

| Metric | Value |
|--------|-------|
| Tests | 734+ passing, 0 failures |
| Version | v0.3.0 |
| Language | TypeScript (strict) |
| License | MIT |

---

## Repository

GitHub: https://github.com/milodule3-debug/aura-code
(Repo renamed from milodule3-debug/rubyness — existing clone URLs redirect automatically)

---

## Links

- [Lean Progress IQ](https://leanprogressiq.com)
- [Aura Manifesto](her-rubyness-manifesto.html)

---

<p align="center">
  Built by <a href="https://leanprogressiq.com">Lean Progress IQ</a>
</p>
