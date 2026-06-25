# Connecting Gmail to Aura

Aura's `gmail` tool (`src/tools/gmail-tool.ts`) lets Aura **list**, **read**, and **send**
email through the real Gmail API. This doc explains exactly what it needs to work,
because the tool itself cannot set up its own credentials — it only *uses* a token
file that has to exist beforehand.

## How it actually works (read this first)

The tool reads OAuth2 credentials from one fixed location:

```
~/.hermes/google_token.json
```

That path is **not** an `aura-code` convention — it's left over from an earlier,
separate project (Hermes Workflows) that did its own Google OAuth setup. `aura-code`
never implemented its own OAuth flow; `gmail-tool.ts` just reads whatever token file
is sitting there and refreshes it when it expires. There is currently no `:gmail-auth`
command or setup wizard in Aura itself.

**What this means in practice:**
- If `~/.hermes/google_token.json` already exists (e.g. because Hermes was set up on
  this machine before) → the tool should work immediately, no setup needed.
- If it does **not** exist → the tool will fail every time with
  `Gmail error: Google token not found at /home/<you>/.hermes/google_token.json`,
  because there is nothing in `aura-code` that can create it. You have to create it
  yourself, once, using Google's own OAuth flow (steps below).

## Checking whether you already have a token

```bash
cat ~/.hermes/google_token.json
```

If that prints JSON with `token`, `refresh_token`, `client_id`, `client_secret` — you're
done. Skip to **Using it**.

If it says "No such file or directory," continue below.

## One-time setup: creating the token file

This only needs to be done once per machine. You need a Google Cloud project with the
Gmail API enabled and an OAuth2 client — if you don't have one yet:

1. Go to [console.cloud.google.com](https://console.cloud.google.com/), create (or
   select) a project.
2. Enable the **Gmail API** for that project (APIs & Services → Library → search
   "Gmail API" → Enable).
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Desktop app**.
   - Note the **Client ID** and **Client Secret** it gives you.
4. Under **OAuth consent screen**, add your own Gmail address as a test user if the
   app is in "Testing" mode (it will be, by default).

Then run the standard Google OAuth "installed app" flow to get a `refresh_token` —
the simplest way is a short script, since `aura-code` doesn't ship one:

```bash
mkdir -p ~/.hermes
python3 -c "
import json, urllib.parse, webbrowser

CLIENT_ID = 'paste-your-client-id-here'
CLIENT_SECRET = 'paste-your-client-secret-here'
REDIRECT_URI = 'http://localhost:8080/'
SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'

params = {
    'client_id': CLIENT_ID,
    'redirect_uri': REDIRECT_URI,
    'response_type': 'code',
    'scope': SCOPES,
    'access_type': 'offline',
    'prompt': 'consent',
}
url = 'https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(params)
print('Open this URL, approve access, then paste the \"code\" param from the redirected URL below:')
print(url)
"
```

Open the printed URL, approve access with your Gmail account, and you'll be redirected
to a `localhost:8080/?code=...` URL that will fail to load (no server is running there
— that's expected). Copy the `code=` value from that URL's address bar, then exchange
it for a token:

```bash
python3 -c "
import json, urllib.request, urllib.parse

CLIENT_ID = 'paste-your-client-id-here'
CLIENT_SECRET = 'paste-your-client-secret-here'
REDIRECT_URI = 'http://localhost:8080/'
CODE = 'paste-the-code-you-copied-here'

data = urllib.parse.urlencode({
    'code': CODE,
    'client_id': CLIENT_ID,
    'client_secret': CLIENT_SECRET,
    'redirect_uri': REDIRECT_URI,
    'grant_type': 'authorization_code',
}).encode()

req = urllib.request.Request('https://oauth2.googleapis.com/token', data=data)
with urllib.request.urlopen(req) as resp:
    tok = json.loads(resp.read())

token_file = {
    'token': tok['access_token'],
    'refresh_token': tok.get('refresh_token'),
    'token_uri': 'https://oauth2.googleapis.com/token',
    'client_id': CLIENT_ID,
    'client_secret': CLIENT_SECRET,
    'scopes': tok.get('scope', '').split(),
    'email': 'your-gmail-address@gmail.com',
}
with open('/root/.hermes/google_token.json' if False else __import__('os').path.expanduser('~/.hermes/google_token.json'), 'w') as f:
    json.dump(token_file, f, indent=2)
print('Saved ~/.hermes/google_token.json')
"
```

**Important:** if Google doesn't return a `refresh_token` in that response (it only
does on the *first* consent, or if you pass `prompt=consent` as above), delete any
prior consent for the app at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) and
redo the authorization step with `prompt=consent` still in the URL.

Set `email` in the saved file to your real Gmail address — `gmail-tool.ts` uses it as
the `From:` header when sending.

## Using it

Once the token file exists, just ask Aura naturally — it has the `gmail` tool
available and will call it:

- "Check my last 5 emails"
- "Read the email with subject 'Invoice'"
- "Send an email to x@example.com with subject 'Hi' and body 'Hello there'"

Or, if you're scripting/debugging the tool directly, its three actions are:

| Action | Required fields | What it does |
|---|---|---|
| `list` | — (optional: `subject`, `max_results`) | Lists recent emails, optionally filtered by subject |
| `read` | `message_id` | Returns From/To/Subject/Date + plain-text body of one message |
| `send` | `to`, `subject`, `body` | Sends an email (auto-detects HTML vs. plain text body) |

## Token expiry & refresh

Access tokens expire (usually ~1 hour); the tool refreshes automatically using the
stored `refresh_token` whenever a call returns `401`, and re-saves the refreshed
token back to the same file. You should never need to redo the setup above unless:
- The `refresh_token` itself is revoked (e.g. you removed app access in your Google
  account's permissions page), or
- You're moving to a new machine without copying `~/.hermes/google_token.json` over.

## Known gaps (being upfront about this)

- **No setup wizard exists in `aura-code` itself.** Every other provider
  (`:provider`) walks you through configuration; Gmail does not. The steps above are
  manual because nothing in the codebase automates them yet.
- **The `.hermes` path is a naming leftover**, not a deliberate `aura-code` choice. If
  you want this cleaned up (e.g. moved to `~/.config/aura-code/google_token.json`),
  that's a real code change to `gmail-tool.ts`, not just a config tweak — say so and
  it can be done.
- **Scopes in the example above are read + send.** If you need other Gmail
  capabilities (e.g. modifying labels), add the relevant scope to `SCOPES` before
  generating the token, and re-run the authorization step.
