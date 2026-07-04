![Aura](./README-hero.jpg)

<p align="center">
  <img src="assets/ruby-diamond.jpg" width="240" alt="Ruby Diamond Technologies" />
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
export ZHIPU_API_KEY="..."              # GLM (Z.ai)
# Local — no API key needed:
# ollama pull qwen2.5-coder:1.5b
```

---

## What She Does

1. **Reads** your codebase — files, structure, dependencies
2. **Plans** a strategy — decides what to change and how
3. **Executes** — writes code, runs commands, makes edits
4. **Verifies** — runs tests, checks file integrity, confirms changes
5. **Reports** — summarizes what was done and what passed

---

### The Memory Loop

Every task feeds forward:

```
TASK → EXECUTE → VERIFY → EPISODE → DREAM → LESSON → next TASK
```

- **EPISODE** — task result recorded automatically in `episodes/*.json`
- **DREAM** — run `:dream` to distill episodes into lessons (`dreams/YYYY-MM-DD.md`)
- **LESSON** — reconciled beliefs injected into every future agent system prompt

See [docs/MEMORY.md](docs/MEMORY.md) and [examples/](examples/) for the full picture.

---

## Voice — talk to Aura (`dic`)

Aura ships with **`dic`**, a standalone speech-to-text / text-to-speech tool. Speak a task; it transcribes and types the words straight into whatever window has focus — Aura's prompt, your editor, anywhere.

```bash
dic                 # record → transcribe → type into the focused window (+Enter)
dic --no-inject     # record → transcribe → clipboard only (no typing)
dic toggle          # hotkey mode: 1st run starts recording, 2nd sends
dic loop            # continuous: speak, pause, it types, repeats
dic speak "hello"   # text-to-speech (MiMo TTS)
dic devices         # list microphones
```

**Speech providers** (first available wins): `PARAKEET_BASE_URL` (local NVIDIA Parakeet, no key) › `XIAOMI_API_KEY` (MiMo ASR) › `OPENAI_API_KEY` (Whisper) › `GROQ_API_KEY` (Whisper via Groq).

### Hands-free hotkey (Linux / Wayland)

`dic toggle` is built to sit behind a global shortcut — press once to start talking, press again to send. Typing into the focused window uses, in order, `wtype` → `ydotool` → `xdotool`.

- **KDE / KWin on Wayland** rejects `wtype`, so install **ydotool** and enable its daemon:

  ```bash
  sudo apt install ydotool
  sudo usermod -aG input $USER          # then log out / in
  systemctl --user enable --now ydotool.service
  ```

- **Binding a key** independent of the desktop is most reliable with **keyd**:

  ```bash
  sudo apt install keyd
  # /etc/keyd/default.conf
  #   [meta]
  #   space = command(/path/to/dic-toggle)
  sudo systemctl enable --now keyd
  ```

Now the flow is: **hotkey → speak → hotkey → your words type into Aura's prompt and run.**

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
| **GLM** (Zhipu / Z.ai) | glm-5.2, glm-5.1, glm-5 — `zhipu-coding/<model>` routes via the Coding Plan endpoint |
| **Ollama** (Local) | Any local model — no API key needed |

Any OpenAI-compatible endpoint also works via `openrouter/<model>`.

---

## Stats

| Metric | Value |
|--------|-------|
| Tests | 951 passing, 0 failures |
| Version | v0.7.2 |
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
