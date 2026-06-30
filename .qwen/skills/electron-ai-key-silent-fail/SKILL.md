---
name: electron-ai-key-silent-fail
description: Diagnose when AI features silently return 'Offline' or 'no API key' despite valid settings
source: auto-skill
extracted_at: '2026-06-06T10:38:00.000Z'
---

# AI silently failing despite valid API key

## Symptom
AI features (transforms, chat, OCR) return "[Offline] Cannot transform X → Y without an AI key" or similar, even though Settings shows a valid API key and the provider appears "Active" in the sidebar.

## Root cause
The `openai` npm package is **not installed**. Electron's `electron/ai.js` does:
```js
try {
  const { OpenAI } = require('openai')
  _client = new OpenAI({ apiKey, baseURL })
} catch {
  return null  // SILENT FAILURE
}
```
The `require('openai')` throws because the package isn't in `package.json`. The try/catch silently returns `null`, which makes every AI call fall through to the offline/error path.

## Fix
```bash
npm install openai
```
Then restart the Electron app (not just Vite HMR — the main process needs a full restart).

## How to verify
Check if `openai` is in `package.json` dependencies. If missing, it's the cause. All providers (OpenAI, Gemini, DeepSeek, Groq, Ollama, OpenRouter, DashScope, Custom) use the OpenAI-compatible client, so this single package affects everything.
