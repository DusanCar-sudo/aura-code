# OpenCode Safety Rules — Aura Code v0.8.0

These rules define what **any AI agent** (OpenCode, Claude Code, Aura itself) may do autonomously on this codebase vs what requires human confirmation.

## ✅ SAFE — Full Autonomy (no approval needed)

### Read operations
- `read_file` any file in the repo
- `search_code` / grep for patterns
- `list_dir` directory trees
- `read_file` files outside repo? → Only `~/.aura/*`, `~/Desktop/*` — and only if explicitly requested by the user

### Build & type checks
- `npx tsc --noEmit -p tsconfig.json`
- `npm run build`
- `npm test` (or `npx vitest run <file>`)
- `ls -la dist/cli/index.js` to verify fresh build

### Non-destructive shell commands
- `cat`, `head`, `tail`, `wc`, `grep`, `find`, `sort`, `uniq`
- `ls`, `stat`, `file`, `du -sh`, `df -h`
- `which`, `type`, `command -v`
- `ps aux`, `free -h`, `uptime`
- `diff`, `cmp`
- `node -e "..."` for quick JS evaluation
- `python3 -c "..."` for quick Python evaluation
- `curl` or `wget` to read HTTP endpoints (no POST to production)
- `npx` to run tools (hyperframes, vercel list/status/inspect)

### Edit operations on source code
- Edit any `.ts`, `.js`, `.mjs`, `.json`, `.md` file inside `/mnt/bigdata/aura/aura-code/`
- Create new `.ts` files in `src/` (new modules, tools, commands)
- Create new `.test.ts` files in `tests/`
- Edit `graphify-out/dashboard.html`, `graphify-out/*.mjs` (graph/render pipeline)
- Edit `site/` files (static site)

### Graph pipeline
- `node graphify-out/rebuild-graph.mjs .`
- `node graphify-out/enrich-data.mjs .`
- `node graphify-out/add-panels.mjs .`

### Writing config files
- `/mnt/bigdata/aura/aura-code/.aura.json` (project-local config)
- `~/.aura/` files (memory, confessions, episodes, queue, sessions) — **only with user intent**

---

## ⚠️ REQUIRES HUMAN CONFIRMATION — Ask First

### Package management
- `npm install <package>` or removing packages from `package.json`
- Modifying `package-lock.json` directly
- Publishing to npm (`npm publish`, `npm version`)

### Git operations
- `git commit` — always explain the diff first, ask "OK to commit?"
- `git push` to any remote
- `git revert`, `git reset`, `git rebase`
- `git merge`
- Creating or deleting branches
- Force push (`git push --force`)

### Destructive file operations
- `rm -rf` any directory or file
- `rm` individual files (ask: "delete this file?")
- `mv` / renaming files across directories
- Overwriting an entire file with `write_file` when it already exists and is large (use `edit_file` instead)

### System operations
- `sudo` anything
- `apt install`, `pip install`, `npm install -g`
- `systemctl` start/stop/restart/daemon-reload
- Modifying `/etc/` files
- `chmod`, `chown`, `mount`, `umount`
- Partitioning (`fdisk`, `parted`, `mkfs.*`)
- Killing processes (`kill`, `pkill`) unless the user explicitly named the process
- Starting background services/daemons
- `ollama pull` (pulling models, bandwidth-heavy)

### Provider & credential operations
- Modifying `~/.aura/telegram.json`
- Running the Telegram bot in production mode
- Modifying `.env` files or `~/.aura/telegram.env`
- Making API calls that consume real money (production LLM calls like `:dream`, `:btw`)
- Sending real emails, Telegram messages, WhatsApp messages
- Deploying to Vercel (`vercel --prod`)
- Publishing releases or creating GitHub releases

### Test suites that cost money
- Tests that call real LLM providers (mock-only tests are fine)
- The `:dream` command (costs 15K+ tokens per call)
- The `:council` command (costs 5 parallel LLM calls)
- Any test that hits a real API endpoint (DeepSeek, Anthropic, OpenAI, Xiaomi, Zhipu, Google)

### CI/CD
- Modifying `.github/workflows/*.yml`
- Modifying `vercel.json`

---

## 🚫 NEVER DO — Hard Block

- **Never** write API keys, tokens, or passwords into files, chat, or logs
- **Never** run code from untrusted sources without review
- **Never** delete files unless explicitly told to by the user AND you've confirmed which file
- **Never** `git push --force` without triple confirmation
- **Never** modify `~/.ssh/`, `~/.config/`, or system credential stores
- **Never** execute commands that modify files outside the repo (home directory configs, system files) unless the user explicitly asked for it and you've explained the impact

---

## MANDATORY VERIFICATION LOOP

After ANY code change:

```
1. npx tsc --noEmit -p tsconfig.json   # zero errors
2. npm test 2>&1 | tail -20             # baseline ~951 tests, no NEW failures
3. npm run build                         # fresh dist/
4. ls -la dist/cli/index.js             # verify timestamp is recent
```

If step 1 or 2 fails, **stop and diagnose**. Do not layer changes on broken builds.

---

## QUICK REFERENCE

| Action | Autonomy |
|--------|----------|
| Read files | ✅ Safe |
| Search code | ✅ Safe |
| Edit .ts source | ✅ Safe |
| Create new .ts | ✅ Safe |
| `npx tsc --noEmit` | ✅ Safe |
| `npm test` | ✅ Safe |
| `npm run build` | ✅ Safe |
| Run graphify pipeline | ✅ Safe |
| `git commit` | ⚠️ Ask |
| `git push` | ⚠️ Ask |
| `npm install` | ⚠️ Ask |
| `rm` anything | ⚠️ Ask |
| `sudo` anything | ⚠️ Ask |
| Kill processes | ⚠️ Ask |
| Deploy to Vercel | ⚠️ Ask |
| Make paid API calls | ⚠️ Ask |
| Write API keys | 🚫 Never |
| `git push --force` | 🚫 Never |
| Modify system config | 🚫 Never |
