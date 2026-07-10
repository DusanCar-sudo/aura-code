# Her Rubyness — Aura Code

> The Ruby-powered AI coding agent for the terminal-first developer.

```bash
npm install -g aura-code
aura --help
```

## Project Structure

```
aura-code/
├── src/
│   ├── index.js          # CLI entry point (aura command)
│   ├── wizard.js          # Interactive setup / model selection
│   ├── repl.js            # REPL loop
│   ├── api.js             # API provider abstraction
│   └── providers/         # Per-provider implementations
│       ├── openai.js
│       ├── anthropic.js
│       ├── openrouter.js
│       ├── local.js       # Ollama / LM Studio
│       └── index.js
├── assets/
│   └── logo.txt           # ASCII logo
├── docs/
│   └── ARCHITECTURE.md
├── package.json
└── README.md
```

## Getting Started

```bash
npm install
npm link   # symlink 'aura' CLI globally
aura       # launch REPL
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `AURA_MODEL` | Preferred model (provider/model-id) | guided by wizard |
| `AURA_PROVIDER` | API provider (openai, anthropic, openrouter, local) | wizard picks |
| `AURA_API_KEY` | API key for chosen provider | prompted on first run |
| `AURA_SYSTEM_PROMPT` | Custom system prompt | built-in |

## Brand

- **Name:** Her Rubyness (the agent persona), Aura Code (the tool)
- **Aesthetic:** Terminal-native, void-black, ruby-red accent
- **Colors:** `#0a0a0a` bg, `#c43c3c` accent, `#e8e4df` ink
- **Fonts:** Space Grotesk (UI), IBM Plex Mono (terminal), Instrument Serif (headings)
- **Owner:** Dusan Milosavljevic
