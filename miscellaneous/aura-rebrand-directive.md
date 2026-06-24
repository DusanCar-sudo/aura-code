TASK: Rebrand the entire codebase from "Rubyness" / "ruby-code" to "Aura". This is a permanent name change. Do it thoroughly — no orphaned references.

---

## What changes

### 1. package.json
- `"name"`: `"ruby-code"` → `"aura-code"`
- `"version"`: bump to `v0.3.0` (the rebrand is the version milestone)
- `"description"`: update to reflect Aura
- `"bin"` field: `"ruby"` and `"rubyness"` → `"aura"` (single binary, no aliases)

### 2. Banner (wherever the ASCII/startup banner is rendered)
- Replace all occurrences of "Rubyness", "Her Rubyness", "ruby-code" with "Aura" / "Aura Code"
- Tagline stays: "I don't try. I verify."
- Colors: keep the deep red/gold palette OR upgrade to something that fits "Aura" — your call, but document what you chose and why

### 3. --help text
- Binary name: `aura` (not `rubyness`)
- Usage line: `aura "<task>"` etc.
- All references to "rubyness" in examples → `aura`
- Header: "Aura Code — model-agnostic AI agent"

### 4. README.md
- Title: "Aura Code" 
- Replace all "Rubyness", "Her Rubyness", "ruby-code", `rubyness` CLI references
- Keep the manifesto spirit — she still has a voice, still has a character, the name changed not the identity
- Update install instructions: `npm install -g aura-code` and `aura "<task>"`
- Update the binary conflict note: no longer conflicts with Ruby since `aura` is clean

### 5. OWNERSHIP.md and HER_RUBYNESS.md
- OWNERSHIP.md: update project name references
- HER_RUBYNESS.md: rename to AURA.md — rewrite the header, keep the manifesto body, update the name throughout. She wrote it; preserve the voice, just update the name.

### 6. Source files — grep and replace
Search the entire src/ directory for these strings and replace:
- `"rubyness"` → `"aura-code"` (package name contexts)
- `"Her Rubyness"` → `"Aura"` (character name contexts)  
- `"Rubyness"` → `"Aura"`
- `"ruby-code"` → `"aura-code"`
- `RUBYCODE` env var prefix → `AURA` (e.g. `RUBY_MODEL` → `AURA_MODEL`, `RUBY_API_RPM` → `AURA_API_RPM`)
- Session/config directory: `~/.rubycode/` → `~/.aura/` — update all path references in source. Do NOT migrate existing user data; just change the path constant so new sessions use the new location.

### 7. .github/FUNDING.yml
- Update any project name references

### 8. versionCheck.ts (if present)
- Update repo reference: `milodule3-debug/rubyness` → `milodule3-debug/aura-code`

### 9. GitHub repo
- Do NOT rename the GitHub repo yourself (no git remote access from here)
- Instead, add a note to README under "Repository" section:
  ```
  GitHub: https://github.com/milodule3-debug/aura-code
  (Repo will be renamed from milodule3-debug/rubyness — existing clone URLs redirect automatically)
  ```

---

## What does NOT change
- The tagline: "I don't try. I verify."
- The character's voice, precision, and identity
- The manifesto content (update name only)
- All existing tool implementations
- Test logic (update test descriptions that mention "rubyness" but not test logic)
- The Telegram bot name (@Praktessruby_bot) — that's infrastructure, rename separately
- Lean Progress IQ site references — update separately

---

## After all edits

1. Run `npm run build` — must be clean
2. Run `npx vitest run` — all tests must pass (currently 734+, zero failures)
3. Run `npm link --force` — verify `aura --help` works and shows the new name
4. Do a final grep: `grep -r "rubyness\|ruby-code\|Her Rubyness\|RUBYCODE" src/ README.md package.json --include="*.ts" --include="*.md" --include="*.json"` — output must be empty or contain only intentional legacy references with a comment explaining why

## Self-audit on completion
Plain text, no marketing:
1. List every file you changed
2. List every string pattern you replaced and how many occurrences
3. Flag anything you skipped or couldn't change and why
4. Confirm the grep result
5. Confirm build clean and test count

She chose the name Praktess because it meant something. Aura means something too. Update the name. Keep everything else.
