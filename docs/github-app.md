# Self-hosted GitHub App (`aura-git`)

Aura Code can act on GitHub as a **GitHub App** without Vercel Connect. The app
authenticates as itself (server-to-server): an RS256 JWT signed with the app's
private key is exchanged for a short-lived installation access token, and that
token drives the REST API.

The private key lives only on the machine running the agent. The Android app
(Aura Droid) and the web client talk to the agent's `/api/github` endpoint and
never hold the key.

## How it works

```
phone ── /api/github (X-Aura-Token) ──> aura-code server
                                          │  GITHUB_APP_ID + private key
                                          ▼
                                      GitHub App (installation token)
```

## 1. Register the app

Use the manifest in `docs/github-app-manifest.json`.

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Upload / paste the manifest (or recreate the fields below by hand).
3. Note the **App ID** shown on the app's settings page.
4. Scroll to **Private keys** → **Generate a private key**. Save the `.pem`.
5. **Install the app** on the account you want it to act on (your account or an
   organization), and grant it access to the repositories it should touch.
6. The **Installation ID** is the numeric id in the URL of the installation
   settings page (`/settings/installations/<id>`). Optional — if omitted, the
   agent discovers it automatically.

## 2. Configure the server

Add to the agent's environment (or `.env`):

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----
# optional:
GITHUB_APP_INSTALLATION_ID=12345678
```

`\n` literals in the key are normalized to real newlines, so the whole PEM fits
on one line. The key is never logged.

## 3. Verify

```
curl -s -X POST http://127.0.0.1:<port>/api/github \
  -H "X-Aura-Token: <token>" -H "Content-Type: application/json" \
  -d '{"action":"test_connection"}'
```

Expected: `{"ok":true,"reposAccessible":N}`.

## Permissions

The manifest requests the minimum for the supported surface:

| Permission      | Access | Why                          |
|-----------------|--------|------------------------------|
| Metadata        | read   | required for every app       |
| Contents        | write  | read + create/update files   |
| Pull requests   | write  | create PRs                   |
| Issues          | write  | comment on issues/PRs        |

If you only need read access, drop `Contents` to **read** and remove the other
write permissions (least privilege).

## Supported actions

`test_connection`, `list_repos`, `get_repo`, `list_contents`, `get_file`,
`create_file`, `update_file`, `list_prs`, `create_pr`, `add_comment`,
`list_commits`.

Webhooks are **not** enabled yet — this is API-driven only.

## Rotating a key

If a private key is ever committed, pushed, or shown in a log, treat it as
compromised: generate a new key on the app settings page, update
`GITHUB_APP_PRIVATE_KEY`, and revoke the old key. The app keeps working
uninterrupted (the App ID does not change).
