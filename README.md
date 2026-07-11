# Aura Code

> Model-agnostic autonomous coding agent. Natural-language task → read codebase → plan → execute → verify → report.

```bash
npm install -g aura-code
aura 'fix the login bug'
```

## Quick Start

```bash
# Install
npm install -g aura-code

# Run (requires at least one provider API key)
export ANTHROPIC_API_KEY=sk-...   # or OPENAI_API_KEY, GOOGLE_API_KEY, etc.
aura 'add a logout button'
```

## Providers (model-agnostic)

| Provider | Models |
|----------|--------|
| Claude (Anthropic) | Opus, Sonnet, Haiku |
| GPT (OpenAI) | gpt-4o, gpt-4o-mini |
| Gemini (Google) | gemini-2.5-pro, gemini-2.5-flash |
| GLM (Zhipu / Z.ai) | glm-5.2, glm-5.1, glm-5 |
| MiMo (Xiaomi) | mimo-v2.5-pro, mimo-v2.5 |
| Ollama | any local model |
| OpenCode Go | Anthropic-compatible endpoint |

Run `aura` without arguments for the interactive setup wizard.

## Features

- **Autonomous execution** — reads files, edits code, runs commands, verifies results
- **Multi-provider fallback** — resilient API handling with circuit breakers
- **TUI mode** — full terminal UI with command palette, diff view, markdown rendering
- **Telegram bot** — voice replies, PC control, file sending
- **Benchmark harness** — reproducible coding tasks with verified outcomes
- **Context compaction** — adaptive memory for long sessions

## CLI Flags

| Flag | Description |
|------|-------------|
| `--auto` | Fully autonomous (no confirmations) |
| `--model <id>` | Specific model (e.g. `claude-sonnet-4`) |
| `--provider <name>` | Force provider |
| `--orchestrate` | Multi-agent mode (Researcher → Coder → Reviewer) |
| `--verify` | Post-task checks with auto-retry |
| `--readonly` | Read-only analysis |
| `--doctor` | Run self-diagnostic checks |

## Configuration

- `.aura.json` — project-level model/provider config
- Global config via first-run wizard
- Environment overrides: `AURA_MODEL`, `AURA_FALLBACK_MODEL`, `AURA_MAX_RETRIES`

## Development

```bash
npm run build     # tsc → dist/
npm run dev       # ts-node src/cli/index.ts
npm test          # vitest
```

## License

MIT
