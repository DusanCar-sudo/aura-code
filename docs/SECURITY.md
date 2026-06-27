# Aura Code — Security Model

Aura is an autonomous coding agent that reads, writes, and executes code on your machine. This document explains what it can do, what it can't, and where your data goes.

## Permission levels

Aura has three permission modes, set at startup or changed during a session:

| Level | What Aura can do | What needs confirmation |
|---|---|---|
| `auto` | Everything. No confirmations. | Nothing — full autonomy. Use in trusted environments only. |
| `normal` (default) | Read files, search code, run tests. | File writes, shell commands, installations, deletions. |
| `read-only` | Read files, search code, web search. | All write operations are blocked entirely. |

Set at startup:
```bash
aura --auto          # full autonomy
aura --readonly      # read-only mode
aura                 # normal (default)
```

Change during a session:
```
:approve all         # switch to auto
:approve normal      # switch to normal
:approve read-only   # switch to read-only
```

## What Aura will never do (regardless of permission level)

- **Delete files** without explicit instruction. Even in `auto` mode, Aura prefers edits over deletions.
- **Commit to git** without explicit instruction. Aura modifies files but never runs `git commit` or `git push` unless you ask.
- **Install packages** without confirmation (in `normal` mode). `npm install`, `pip install`, etc. are flagged as potentially destructive.
- **Access files outside the project root** unless the task specifically requires it.

## Tool-level safety

Each tool call is checked against the current permission level before execution:

| Tool | `auto` | `normal` | `read-only` |
|---|---|---|---|
| `read_file`, `search_code`, `list_dir` | Allowed | Allowed | Allowed |
| `web_search`, `web_fetch` | Allowed | Allowed | Allowed |
| `write_file`, `edit_file` | Allowed | Confirm | Blocked |
| `run_command` (non-destructive) | Allowed | Allowed | Blocked |
| `run_command` (destructive — rm, install, etc.) | Allowed | Confirm | Blocked |
| `delete_file` | Allowed | Confirm | Blocked |

## What leaves your machine

### To the LLM provider

When Aura runs a task, it sends the following to your configured LLM provider (OpenAI, Anthropic, DeepSeek, Google, Xiaomi, etc.):

- The **system prompt**, which includes:
  - Your project's language, framework, and name
  - A truncated directory tree (depth 3, common files only)
  - A truncated README (first 2000 chars)
  - Your package.json / requirements.txt (first 1500 chars)
  - Last 10 git commit messages (summaries only, not diffs)
  - Reconciled memory from past sessions (if it exists, max 2000 chars)
- The **conversation history** for the current session
- **File contents** you ask Aura to read (only the files it reads, not your entire codebase)
- **Tool call results** (search results, command output, etc.)

### What is NOT sent

- Files Aura doesn't read during the task
- Git diffs, patches, or full commit contents (only `--oneline` summaries)
- Environment variables or API keys (except the one used to authenticate with the LLM provider itself)
- The contents of `~/.config/aura-code/.env`
- Episode data or dream files (these stay local unless you manually share them)

### To web search providers

When Aura uses `web_search`, the search query is sent to one of:

1. **Tavily** (if `TAVILY_API_KEY` is set) — query sent to `api.tavily.com`
2. **Serper** (if `SERPER_API_KEY` is set) — query sent to `google.serper.dev`
3. **DuckDuckGo** (no key) — query sent to `html.duckduckgo.com`

Only the search query string is sent. No project context, no file contents, no personal data.

## API key storage

API keys are stored in one of these locations (never in the repo):

| Location | What goes there |
|---|---|
| `~/.config/aura-code/config.json` | Provider config from the setup wizard (model, base URL). API key if saved during wizard. |
| `~/.config/aura-code/.env` | Additional keys (e.g. `TAVILY_API_KEY`, `SERPER_API_KEY`). Loaded at startup by `bootstrapAuraEnv`. |
| Environment variables | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, etc. Standard env var convention. |

Keys are **never written to files inside the repository**. The `.gitignore` includes `.env*` rules to prevent accidental commits.

### Key handling in the agent loop

- API keys are passed to the provider constructor and used for HTTP authentication headers.
- Keys are **never echoed to the terminal**, written to log files, or included in episode/dream data.
- The Gmail OAuth tool has explicit guards: tokens are used for API calls but never printed to chat output.

## Session data

### What stays on disk

| Data | Location | Lifespan |
|---|---|---|
| Session history | `~/.aura/sessions/<project>/` | Until you delete it or run `:delete <id>` |
| Episodes | `<project>/episodes/` | Permanent (append-only) |
| Dreams | `<project>/dreams/` | Permanent (append-only) |
| Reconciled memory | `<project>/dreams/.reconciled.md` | Regenerated each `:dream` run |
| Blueprints | `~/.aura/blueprints/` | Until you delete them |
| Workflows | `~/.aura/workflows/` | Until you delete them |

### What is ephemeral

- Conversation turns in the current REPL session (not persisted unless sessions are enabled)
- Compacted history (old turns are summarized and the originals are discarded from memory)
- Tool call results (consumed and discarded after the agent processes them)

## The Machina verifier

`:machina` is Aura's self-verification system. It maintains a formal model of the codebase and checks its own claims against real source:

- If Aura claims "line 224 of loop.ts does X", machina verifies that line 224 actually contains X.
- If code changes shift line numbers, machina detects the drift and flags it.
- The verifier is read-only — it never modifies source code.

This is a safety mechanism against hallucination, not a security boundary. It catches mistakes, not malice.

## Threat model (honest assessment)

### What Aura protects against

- **Accidental file destruction** — permission system, confirmation prompts, preference for edits over deletions.
- **Accidental git commits** — never commits unless explicitly told to.
- **Token waste from broken tools** — loud errors instead of silent retry loops.
- **Hallucinated claims about the codebase** — machina verifier, council-verify for research.
- **API key leakage into the repo** — `.gitignore` rules, keys stored outside project root.

### What Aura does NOT protect against

- **A malicious LLM provider.** If your provider is compromised, they see everything Aura sends (see "What leaves your machine" above). Mitigation: use a trusted provider; for sensitive work, use a local model via Ollama.
- **A compromised machine.** Aura runs with your user permissions. If your machine is compromised, Aura's safety layer is irrelevant. Mitigation: standard machine security (biometrics, disk encryption, etc.).
- **Prompt injection from untrusted files.** If Aura reads a file containing adversarial instructions, it may follow them. Mitigation: review what Aura does in `normal` mode (confirmations on write operations).
- **Model confabulation on research tasks.** The council and machina systems reduce this but don't eliminate it. The agent can and will sometimes state false things confidently. Mitigation: verification steps, `:machina`, `council-verify`.

## Reporting vulnerabilities

If you find a security issue in Aura Code, please open a private issue on GitHub or email `leanproiq@gmail.com`. Do not post exploit details in public issues.
