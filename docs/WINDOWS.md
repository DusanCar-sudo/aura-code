# Aura on Windows

Getting Aura running on Windows 10 or 11, written for someone who has never
opened a terminal before. If you have Node.js already, skip to
[Install Aura](#3-install-aura).

A styled version is published at
[v2-seven-flax.vercel.app/aura-windows-manual](https://v2-seven-flax.vercel.app/aura-windows-manual)
(source: `site/aura-windows-manual.html`). This file is the one that is always
current, because it lives with the code and is updated in the same commit.

---

## 1. Install Node.js

Aura runs on Node.js, so that goes on first. You need **version 18 or newer**.

1. Open your browser — Edge, Chrome, Firefox, any of them.
2. Go to **[nodejs.org](https://nodejs.org)**.
3. Click the big green **LTS** button (Long Term Support). An installer
   downloads.
4. Double-click the downloaded `.msi` file. Accept every default and click
   **Install**. When Windows asks for administrator permission, click **Yes**.

## 2. Open a terminal

Press the **Windows key**, type `terminal` (or `cmd`), and press **Enter**.

A black or blue window opens with a blinking cursor. Nothing here can break your
computer — you are just typing instructions instead of clicking them.

Check the install worked. Type each line and press Enter:

```
node --version
npm --version
```

You should see version numbers, something like `v20.11.0` and `10.2.4`. If you
instead see *"'node' is not recognized"*, close the terminal, open a new one,
and try again — Windows only notices a new install in windows opened after it.

## 3. Install Aura

```
npm install -g aura-code
```

This takes a minute or two. Then confirm it:

```
aura --version
```

## 4. Give Aura a model to think with

Aura does not include an AI model. You point her at one, and you choose which —
that is what "model-agnostic" means. You need **one** key, not all of them.

| Provider | Where to get a key | Cost |
|---|---|---|
| Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com) | Pay as you go |
| OpenAI (GPT) | [platform.openai.com](https://platform.openai.com) | Pay as you go |
| Google (Gemini) | [aistudio.google.com](https://aistudio.google.com) | Free tier available |
| DeepSeek | [platform.deepseek.com](https://platform.deepseek.com) | Low cost |
| Zhipu (GLM) | [z.ai](https://z.ai) | Low cost |
| Ollama | [ollama.com](https://ollama.com) | Free, runs on your own machine |

An API key is a long password that lets Aura talk to the model. It usually
starts with `sk-`. Treat it like a credit card number: never paste it into a
chat, a screenshot, or a public repository.

**For this terminal session only:**

```
set ANTHROPIC_API_KEY=sk-ant-your-key-here
```

**Permanently, for every future terminal:**

```
setx ANTHROPIC_API_KEY "sk-ant-your-key-here"
```

`setx` only affects terminals you open *afterwards*, so close this one and open
a new one before testing.

## 5. Run your first task

Move to a project folder and describe what you want in plain English:

```
cd C:\Users\You\my-project
aura "list all the code files in this folder and tell me what they do"
```

Aura reads the folder, plans, acts, checks her work, and reports back.

Good first tasks, in increasing order of nerve:

```
aura "find all the TODO comments in this project"
aura "explain what this codebase does"
aura "add a README with setup instructions"
aura "fix the bug in the login form"
```

---

## Everyday commands

| Command | What it does |
|---|---|
| `aura "your task"` | The normal loop: read, plan, execute, verify, report |
| `aura` | Opens the interactive session (TUI) |
| `aura --help` | Every flag, with explanations |
| `aura --version` | Which version you have |
| `aura --models` | Lists the models your keys can reach |
| `aura --doctor` | Checks your setup and tells you what is missing |

If something behaves oddly, `aura --doctor` is the first thing to run. It names
the package to install rather than describing the symptom.

## Modes

| Flag | Use it when |
|---|---|
| *(none)* | Ordinary work — a feature, a fix, a question |
| `--plan` | You want the plan first, before anything is changed |
| `--architect` | Design and specification only; no files are edited |
| `--orchestrate` | Large jobs — researcher, coder and reviewer working together |
| `--verify` | Run the tests and keep fixing until they pass |
| `--analyze` | Look back over past sessions for recurring failures |
| `--gazelle` | Conversational mode, for talking rather than tasking |

## Safety

You decide how much rope she gets.

| Level | What she may do |
|---|---|
| `--readonly` | Read files only. No edits, no commands. The safe way to explore. |
| *(default)* | Read and edit files; asks before running shell commands. |
| `--auto` | Full autonomy, no prompts. For projects you trust. |

Start with `--readonly` on a codebase you care about. Move to the default once
you have seen how she works. Save `--auto` for a repository with a clean commit
you can return to.

## A note on computer use

Aura can take over the screen, mouse and keyboard — but **that feature is Linux
only right now**. Windows support is planned for the next release. Everything
else in this guide works on Windows today.

---

## When something goes wrong

**"'aura' is not recognized"**
The install did not finish, or this terminal predates it. Open a new terminal
and try `aura --version`. If it still fails, re-run
`npm install -g aura-code` and read the output for an error.

**"No API key found"**
The key is not set in *this* terminal. If you used `setx`, open a new terminal —
the old one cannot see it. Confirm with `echo %ANTHROPIC_API_KEY%`.

**Aura stops halfway through a long answer**
The model ran out of output budget. Set `AURA_MAX_TOKENS=32768` and try again.
Reasoning models spend that budget on thinking before they write anything.

**A permission error on install**
Open the terminal as Administrator: press the Windows key, type `terminal`,
right-click **Windows Terminal**, choose **Run as administrator**.

**Everything is slow or expensive**
Use a cheaper model for routine work — `aura -m gemini-2.5-flash "..."` or a
local Ollama model, which is free. `aura --models` shows what you can reach.

---

## Where to go next

- [README](../README.md) — what Aura is and why she is built this way
- [CHANGELOG](../CHANGELOG.md) — what changed in each release
- `aura --help` — the full flag list, always current
