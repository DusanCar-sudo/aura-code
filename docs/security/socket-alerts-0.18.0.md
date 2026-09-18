# Socket.dev alerts on aura-code@0.18.0 — remediation handoff

Source: https://socket.dev/npm/package/aura-code/alerts/0.18.0 (collected
2026-09-19 by Dusan with Claude on claude.ai). 197 artifacts in the install
tree; 327 raw alerts on aura-code itself plus findings across 22 direct deps.
Goal: clear the real risks, shrink the alert surface, ship a clean release.
Progress is tracked at the end of this file.

Scoped names: Socket drops the scope in some views. `sdk` = `@anthropic-ai/sdk`,
`cli` = `@tauri-apps/cli`, `browsers` = `@puppeteer/browsers`,
`generative-ai` = `@google/generative-ai`, `connect` = `@vercel/connect`,
`xterm@6.0.0` = `@xterm/xterm`, `addon-fit@0.11.0` = `@xterm/addon-fit`.

## P0 — High CVE

| Package | Advisory | CVSS | Issue | Vulnerable | Patched |
|---|---|---|---|---|---|
| image-size@1.2.1 | CVE-2025-71329 / GHSA-5p2g-fcmc-qvqq | 8.7 | JXL + HEIF parsers infinite loop → DoS | <= 2.0.2 | none yet |
| image-size@1.2.1 | CVE-2025-71330 / GHSA-w3rx-r6r6-pgpr | 8.7 | ICNS parser infinite loop → DoS | <= 2.0.2 | none yet |

No fix exists. Options: make pptxgenjs (the likely parent) optional/lazy,
never feed untrusted image buffers into it, bump when a fix ships.

## P0 — aura-code's own code (Socket "AI-detected potential security risk")

| File (dist/) | Sev | Problem | Fix |
|---|---|---|---|
| tools/image-read.js | 0.86 | user paths in `execSync` shell strings; unrestricted reads; base64 branch returns any file | argv exec; restrict paths; image mime check |
| tools/ftp-upload.js | 0.88 | shell `curl` from untrusted input; FTP creds in URL (visible in `ps`) | `execFile('curl', args)`; creds via netrc/stdin, never in argv |
| tools/cron.js | 0.88 | `run` executes `input.command` via `execSync`; edits crontab | confirmation/allowlist; no shell string; validate |
| tools/telegram-bot.js | 0.85 | remote `/run`, `/read` `/ls` `/search` `/sendfile`, `/cam` | fail-closed chat-ID allowlist; `/run` + `/cam` off by default; path sandbox |
| tools/mcp.js | 0.78 | spawn with runtime command/args; full env inherited | minimal env allowlist; validate config; no `shell:true` |
| verify/checks.js | 0.78 | `execSync` of `ctx.testCommand` / tool commands, weak gating | argv, allowlist runners, no shell |
| plugins/hooks.js | 0.78 | hook commands with `shell:true`, full env | trust prompt per plugin, argv, scrubbed env |
| tools/browser.js | 0.78 | unrestricted navigation + caller JS via `page.evaluate` | scheme allowlist (block `file:`), gate evaluate |
| cli/repl-catch-command.js | 0.78 | records keystrokes/screens, prints typed text | redact typed text, 0600 files, explicit opt-in |
| tools/index.js | 0.72 | dispatch exposes shell/fs/network without central authz | one permission gate in the dispatcher |

Medium "code anomaly": viz/index (`applyPanels()` paths in shell), tools/dictate,
doctor/checks, doctor/repair, setup/telegram-wizard (`testBotToken` shells out
with the token), setup/provider-test, research/council. Same pattern.

Global rule: replace `execSync(`/`exec(`/`shell: true`/template-string commands
with `execFile`/`spawn(cmd, args, { shell: false, env: minimalEnv })`, ideally
through one `src/util/exec.ts`. 29 files use child_process: verify/checks,
viz/index, agent/context, checkpoints/engine, cli/web-launcher, doctor/checks,
doctor/repair, harness/proposer, plugins/hooks, plugins/market,
providers/factory, record/recorder, safety/sandbox, server/index, server/lan,
tools/clipboard, tools/cron, tools/dictate, tools/document, tools/email,
tools/ftp-upload, tools/image-read, tools/mcp, tools/notify, tools/pdf-text,
tools/screen/sidecar, tools/tools, util/chrome, util/open.

## P1 — Supply chain / deprecated

- jszip@3.10.2: new publisher (`jkoops`) → diff against 3.10.1, pin via
  `overrides` if anything is off. License reads GPL-3.0-or-later; jszip is
  `MIT OR GPL-3.0` → choose MIT, note it in THIRD-PARTY notes. Via pptxgenjs.
- openai@4.104.0: `bin/cli migrate` runs `npx` on an unverified tarball →
  upgrade to the current major (also drops node-domexception, node-fetch).
- node-pty@1.1.0: install script + native code; expected → optionalDependencies
  + lazy import.
- Deprecated: `xterm`, `xterm-addon-fit` (remove; `@xterm/*` already deps),
  `glob@10` (bump or `fs.glob`), `node-domexception` (goes with openai).

## P2 — Hygiene

- `@tauri-apps/cli` (59 env-var alerts) and `@tauri-apps/api` → devDependencies.
- puppeteer-core (+ @puppeteer/browsers, chromium-bidi) and pptxgenjs →
  optional + lazy `import()`; validate pptx media paths.
- chalk 4 → 5 or `node:util.styleText` (low priority).
- `npx socket optimize` offers 9 overrides (es-define-property,
  es-set-tostringtag, function-bind, has-tostringtag, hasown, isarray,
  safe-buffer, safer-buffer, side-channel); review the diff before committing.

## Informational

Unmaintained (34, mostly express/openai-v4/jszip transitive, incl. the
`https@1.0.0` stub: check `npm ls https`), new-author (express 5 org moves),
minified, dynamic require, debug access (`protocol/handler.js` async_hooks),
eval (browser.js ×2, puppeteer ×14), shell ×29, network ×41, env ×148,
fs ×87 in aura-code. AI code anomaly on 34 well-known deps: no action.

## Task list

1. `npm ls image-size jszip node-domexception https glob xterm`.
2. package.json: drop `xterm`, `xterm-addon-fit`; `@tauri-apps/*` →
   devDependencies; `node-pty`, `puppeteer-core`, `pptxgenjs` →
   optionalDependencies with lazy `import()` and a friendly error.
3. Upgrade openai, glob, @anthropic-ai/sdk, @google/generative-ai; fix breaks.
4. `npm diff` jszip 3.10.1 vs 3.10.2; pin if needed.
5. `src/util/exec.ts`; refactor the 10 P0 files, then the medium ones.
6. Telegram: fail-closed allowlist; `/run` and `/cam` off by default.
7. Central permission gate in the tools dispatcher.
8. `npx socket optimize` (review diff).
9. `npm pack --dry-run`; Socket CLI scan if set up.
10. Bump, CHANGELOG "Security hardening", publish, re-check Socket.

## Re-pull the raw data (unofficial web API; may change)

```bash
curl -s 'https://socket.dev/api/ecosystems/alert/alert-types' > types.json
curl -s 'https://socket.dev/api/ecosystems/artifact/poll-with-alerts?name=aura-code&type=npm&version=0.18.0' > alerts.ndjson
node -e '
const fs=require("fs");const T=JSON.parse(fs.readFileSync("types.json"));const id={};
for(const v of Object.values(T)) id[v.id]=v.type;
for(const l of fs.readFileSync("alerts.ndjson","utf8").split("\n").filter(Boolean)){
  const a=JSON.parse(l); for(const x of a.alerts||[])
    console.log([id[x.type]||x.type, a.name+"@"+a.version, x.file||"", JSON.stringify(x.props||{}).slice(0,200)].join("\t"));
}' > socket-alerts.tsv
```

Official route: `npm i -g socket`, log in, use its scan commands with `--json`.

## Progress

(filled in as the work lands)
