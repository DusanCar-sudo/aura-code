---
name: silent-require-failure-in-electron-ai
description: When Electron main-process AI features fail with "Offline" despite valid API keys, check whether the `openai` npm package is installed — a silent `require('openai')` inside try/catch returns null and masks the real cause
source: auto-skill
extracted_at: '2026-06-06T02:41:49.228Z'
---

## The trap

In Electron apps that use OpenAI-compatible SDKs in the **main process** (not the renderer), a common pattern looks like:

```js
function getClient(provider, apiKey, customBaseUrl) {
  const sig = `${provider}|${apiKey}|${baseURL}`
  if (_client && _clientSig === sig) return _client
  try {
    const { OpenAI } = require('openai')
    _client = new OpenAI({ apiKey, baseURL })
    return _client
  } catch {
    return null  // ← silent failure
  }
}
```

If `openai` was never added to `package.json` and installed, `require('openai')` throws — but the `catch` swallows it and returns `null`. Downstream code checks for `null` and shows a generic **"Offline: No AI key configured"** message, even when the user has a valid API key set in Settings.

**Why this is deceptive:** The Settings UI shows "Gemini: Active" (or similar) because that check only reads the stored provider/key from `electron-store` — it doesn't actually instantiate the AI client. The client instantiation only happens in the main process when an AI call is made, and the failure is silent.

## How to diagnose

1. Check that `openai` is in `package.json` dependencies:
   ```bash
   grep '"openai"' package.json
   ```
2. Check the main-process output for errors. The `catch` block may not log anything, but the require failure won't appear in the renderer's DevTools — only in the terminal where Electron was launched.
3. Temporarily add logging inside the `catch`:
   ```js
   } catch (e) {
     console.error('getClient: failed to require openai:', e.message)
     return null
   }
   ```

## How to fix

```bash
npm install openai
```

Then restart the Electron app. All AI-powered features (transforms, chat, OCR, etc.) will start working immediately with the user's existing API key — no configuration changes needed.

## Prevention

When setting up an Electron project that uses `openai` in the main process, ensure `openai` is an explicit dependency (not transitive). The renderer processes don't need it — only the main process does — so it's easy to miss during setup if the focus was on the frontend bundle.
