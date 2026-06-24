# Telegram Bot Setup

Run Aura as a Telegram bot — send it tasks from your phone, get results back
as text or voice, from anywhere with a Telegram client.

---

## Quick Start (recommended)

```bash
aura
:telegram
```

The wizard walks through everything: bot token, who's allowed to use it,
which model it should run tasks with, optional voice support, and —
genuinely the most useful part — it can generate a working systemd service
file for you, so the bot keeps running in the background and survives
reboots.

The one thing nothing can automate: you need a bot token from Telegram's
own @BotFather first. The wizard tells you exactly how when you get there,
but in short:

1. Open Telegram, message **@BotFather**
2. Send `/newbot`
3. Pick a display name, then a username ending in `bot`
4. BotFather replies with a token like `123456789:ABC-DEF1234ghIkl...`

Paste that into the wizard when asked.

---

## What the Wizard Actually Does

| Step | What happens |
|---|---|
| **Bot token** | Asks for your token; if one's already configured, offers to keep or replace it |
| **Verify** | Calls Telegram's real API to confirm the token works — shows your bot's actual `@username` back to you |
| **Authorized users** | Who can message the bot. The bot **refuses to start** with zero authorized users — this is deliberate, no open-access bots |
| **Task model** | Reuses your `:provider` setup if you've already run it, or lets you skip and configure manually later |
| **Voice (optional)** | Asks for a free Groq API key if you want voice message transcription + spoken replies |
| **systemd service** | Optionally generates `~/.config/systemd/user/aura-telegram.service` with everything filled in correctly |

### Adding more authorized users later

Run `:telegram` again — it shows who's currently authorized and lets you
add more (each person needs their own numeric Telegram user ID, which they
can get instantly by messaging **@userinfobot**).

---

## Manual Setup (without the wizard)

If you'd rather configure everything by hand, or you're scripting a
deployment:

**1. Create `~/.aura/telegram.json`:**
```json
{
  "bot_token": "123456789:ABC-DEF1234ghIkl...",
  "allowed_user_ids": "111111111,222222222"
}
```
`allowed_user_ids` is a comma-separated string of numeric Telegram user IDs.
The bot will not start without at least one.

**2. Build and run:**
```bash
npm run build
node dist/tools/telegram-bot.js
```

**3. Optional environment variables**, set however you normally manage env
vars (shell profile, systemd `Environment=`, etc.):

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_MODEL` | Which model the bot uses for tasks (default: `deepseek/deepseek-v4-flash`) |
| `GROQ_API_KEY` | Enables voice message transcription and spoken replies |
| `<PROVIDER>_API_KEY` | Whichever key matches your task model's provider (e.g. `XIAOMI_API_KEY`, `DEEPSEEK_API_KEY`) |
| `TELEGRAM_BOT_ALLOWED_USER_IDS` | Alternative to `allowed_user_ids` in the JSON config — same comma-separated format |

### Running it as a systemd service by hand

```ini
# ~/.config/systemd/user/aura-telegram.service
[Unit]
Description=Aura Telegram Bot
[Service]
WorkingDirectory=/path/to/aura-code
ExecStart=/path/to/node /path/to/aura-code/dist/tools/telegram-bot.js
Environment="TELEGRAM_BOT_MODEL=deepseek/deepseek-v4-flash"
Environment="DEEPSEEK_API_KEY=sk-..."
Environment="GROQ_API_KEY=gsk-..."
Environment="TELEGRAM_BOT_ALLOWED_USER_IDS=111111111,222222222"
Restart=always
RestartSec=5
StandardOutput=append:/home/you/.aura/telegram-bot.log
StandardError=append:/home/you/.aura/telegram-bot.log
[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now aura-telegram.service
systemctl --user status aura-telegram.service
```

Use `/path/to/node` from `which node` (or `process.execPath` if you're
scripting this) — not just `node`, since systemd user services don't always
inherit your shell's `PATH`.

---

## Adding a Second User (e.g. a family member)

1. Have them message **@userinfobot** to get their numeric Telegram ID.
2. Run `:telegram` again, or manually add their ID to `allowed_user_ids`.
3. Restart the bot for the change to take effect:
   ```bash
   systemctl --user restart aura-telegram.service
   ```
4. Add the bot to a group chat if you want shared access — search for your
   bot's username in Telegram, add it to the group normally.

By default, bots in a group only respond to `/commands` or messages that
@mention them. To make it respond to anything said in the group, disable
**Group Privacy** for your bot via @BotFather → `/mybots` → your bot →
**Bot Settings** → **Group Privacy** → **Turn off**.

---

## Voice Messages

Send the bot a voice message — it transcribes it via Groq's Whisper API,
runs it as a normal task, and replies with both text and a spoken voice
reply.

Requires `GROQ_API_KEY` — get a free one at
[console.groq.com/keys](https://console.groq.com/keys).

---

## Troubleshooting

### "Provider error... model X not found" / wrong API used for a task

The model and the API key it's trying to use don't match — usually means
`TELEGRAM_BOT_MODEL` is set to one provider's model while a *different*
provider's key is the one actually configured. Check that the env var
matching your model's provider family is set (see the table above), and
that there isn't a leftover key from a different provider taking priority.

### `409` error / "another host is polling the same bot token"

Two processes are running the bot with the same token at once — usually a
manually-started `node dist/tools/telegram-bot.js` left running alongside
the systemd service. Find and stop the duplicate:
```bash
ps aux | grep telegram-bot
kill <pid>
```

### Voice messages fail with "fetch failed" / ETIMEDOUT / ENETUNREACH

This is a real, known issue, not a bug in your setup: on some networks,
Node's native `fetch` fails to connect to external hosts because of how it
races IPv4/IPv6 connection attempts ("Happy Eyeballs") on networks where
IPv6 is advertised but not actually routable. The bot's networking code
works around this by shelling out to `curl` instead — if you're seeing this
error, you may be running an older version that still uses native fetch
for these calls. Check that `src/tools/telegram-voice.ts` uses
`child_process`/`exec`, not `fetch`, for its network calls.

You can confirm this is the cause yourself:
```bash
node -e "fetch('https://api.telegram.org').catch(e => console.log(e.cause))"
```
If that shows `ETIMEDOUT`/`ENETUNREACH`, this is the issue.

### "file must be one of the following types" from Groq's Whisper API

Telegram's voice files report a `.oga` extension internally, which Groq's
API rejects outright — even though the actual audio content (Ogg/Opus) is
something it does accept under `.ogg`. The fix is to label the downloaded
file `.ogg` regardless of Telegram's original extension before uploading it
to Groq; this is already handled correctly in the current code, so if
you're hitting this, you may be running an older version.

### Changes to env vars / config aren't taking effect

The bot only reads its configuration at startup — it has to be **restarted**
after any change, whether that's the JSON config file or environment
variables:
```bash
systemctl --user restart aura-telegram.service
```

### Copy-pasted a file and the build/tests don't match what was expected

If a file you copied doesn't seem to reflect the change you just made,
check for duplicate downloads — browsers often save a second copy as
`filename (1).ext` instead of overwriting, silently leaving the old version
in place if you grab the wrong one:
```bash
ls ~/Downloads/ | grep <filename>
md5sum ~/Downloads/<filename> ~/Downloads/"<filename> (1)"*
```
Compare against the hash of the file you were actually given, and copy
whichever one actually matches.
