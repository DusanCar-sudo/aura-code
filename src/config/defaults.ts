export const DEFAULTS = {
  // No default model — the user picks their own on first run via the wizard.
  // This keeps the codebase provider-agnostic: nothing here assumes a specific vendor.
  defaultModel: undefined as string | undefined,
  // NOTE: there is deliberately no `maxTokens` here. Per-call output caps are
  // per-provider, because each vendor's ceiling differs, and the factory never
  // passed a value through — so a `maxTokens` on this object was dead config
  // that disagreed with what actually shipped. The live defaults are:
  //   openai-compatible.ts  16384
  //   anthropic.ts           8192
  //   google.ts              8192
  // Override per provider via ProviderConfig.maxTokens.
  maxContextFiles: 20,
  maxFileLinesInContext: 300,
  maxDirDepth: 4,
  toolTimeout: 30_000,     // 30s max per tool execution
  maxTurns: 50,             // prevent infinite loops; matches DEFAULT_MAX_TURNS
  confirmDangerous: true,   // ask before destructive ops
  autoApprove: false,       // --auto flag overrides
  verify: false,            // --verify flag enables post-task verification
  maxVerifyRetries: 3,      // retries when verification fails
  testCommand: undefined as string | undefined, // custom test command for verification
  profile: 'default' as 'default' | 'local',    // 'default' or 'local' (Ollama)
  checkpoints: true,        // shadow-git snapshots before mutating tool calls
  maxCheckpoints: 30,       // retention per repo — older refs pruned automatically
  // Local profile (--profile local / profile: "local" in .aura.json)
  localProfile: {
    model: 'qwen2.5-coder:7b',
    baseUrl: 'http://localhost:11434/v1',
    contextWindow: 8192,
    maxTokens: 2048,
  },
};

export const DANGEROUS_COMMANDS = [
  'rm -rf', 'rmdir', 'del /f', 'format',
  'dd if=', 'mkfs', 'fdisk', ':(){', 'fork bomb',
  'chmod 777', 'chown root', 'sudo rm',
  '> /dev/ (except null/zero/random)', 'curl.*|.*sh', 'wget.*|.*sh',
  'shutdown', 'reboot',
];

// NOTE: a regex denylist over a shell *string* is best-effort only — shell
// quoting, flag variants, and interpreters defeat it (see permissions.ts for
// the structural mitigations). It is a backstop, never the primary boundary.
export const DANGEROUS_PATTERNS: RegExp[] = [
  // rm with any recursive/force flag: -rf, -fr, -r, -f, --recursive, --force
  /\brm\s+(?:-[a-z]*[rf][a-z]*|--(?:recursive|force|no-preserve-root))\b/i,
  /\bmkfs\b/,
  /\bdd\s+if=/i,
  /\bfdisk\b/,
  /:\(\)\s*\{/,                         // fork bomb
  />\s*\/dev\/(?!null\b|zero\b|random\b|urandom\b|full\b|fd\b|stdout\b|stderr\b)/,  // redirect to device (allow /dev/null etc.)
  /\|\s*(ba)?sh\b/,
  /\bwget\b.*\|\s*(ba)?sh/i,
  /\bcurl\b.*\|\s*(ba)?sh/i,
  /\bfind\b.*\s-(?:delete|exec|execdir)\b/i,   // find … -delete / -exec is a deletion/exec vector
  /\bchmod\s+(?:-R\s+)?[0-7]*7[0-7]{2}\b/,      // world-writable/executable (…7xx, e.g. 777, 757)
  /\bchown\s+root\b/,
  /(?:^|[;&|]+\s*)(?:sudo\s+)?\bshutdown\b/,   // shutdown as actual command, not substring
  /(?:^|[;&|]+\s*)(?:sudo\s+)?\breboot\b/,     // reboot as actual command, not substring
  /\bsource\s+\/dev\//,
];

/**
 * The same screen for cmd.exe and PowerShell.
 *
 * Every pattern above is POSIX — rm, dd, mkfs, chmod — and none of them can
 * match anything cmd.exe or PowerShell would run, so on Windows the denylist
 * caught nothing at all. `del /s /q C:\` and `format C: /y` went straight
 * through.
 *
 * Applied on every platform rather than switched by process.platform: Git
 * Bash, WSL invoked from a Windows shell, and Windows containers all mean the
 * running shell is a poor proxy for which syntax can reach the OS, and a
 * PowerShell string is inert on Linux anyway. Screening both costs nothing
 * and removes the chance of guessing wrong.
 */
export const WINDOWS_DANGEROUS_PATTERNS: RegExp[] = [
  // Recursive delete: del /s, rd /s, rmdir /s. The /s is what makes it the
  // equivalent of rm -rf rather than a single-file removal.
  /\b(?:del|erase)\b[^|&;]*\s\/s\b/i,
  /\b(?:rd|rmdir)\b[^|&;]*\s\/s\b/i,
  // PowerShell's Remove-Item and its aliases (ri, rm, del, rd) with -Recurse.
  /\b(?:remove-item|ri)\b[^|&;]*\s-recurse\b/i,
  /\bget-childitem\b[^|&;]*\|\s*(?:remove-item|ri|rm|del)\b/i,
  // Whole-volume operations.
  /\bformat\s+[a-z]:/i,
  /\bformat-volume\b/i,
  /\bclear-disk\b/i,
  /\bdiskpart\b/i,
  // Shadow-copy and backup destruction — the signature move of ransomware,
  // and never something a coding agent has cause to do.
  /\bvssadmin\b[^|&;]*\bdelete\b/i,
  /\bwbadmin\b[^|&;]*\bdelete\b/i,
  /\bcipher\b[^|&;]*\s\/w\b/i,
  // Boot configuration and registry hives.
  /\bbcdedit\b/i,
  /\breg\s+delete\s+"?hk(?:lm|cr|u|ey_local_machine|ey_classes_root)\b/i,
  /\bremove-item\b[^|&;]*\bhk(?:lm|cr):/i,
  // Ownership and ACL takeovers across a tree.
  /\btakeown\b[^|&;]*\s\/r\b/i,
  /\bicacls\b[^|&;]*\/grant\s+\S*everyone/i,
  // Download-and-execute, the PowerShell counterpart of `curl … | sh`.
  /\|\s*(?:iex|invoke-expression)\b/i,
  /\b(?:iex|invoke-expression)\s*\(/i,
  /\b(?:iwr|invoke-webrequest|curl|wget)\b[^|&;]*\|\s*(?:iex|invoke-expression)\b/i,
  /\bdownloadstring\s*\(/i,
  // Living-off-the-land download vectors.
  /\bcertutil\b[^|&;]*-urlcache\b/i,
  /\bbitsadmin\b[^|&;]*\/transfer\b/i,
  /\bmshta\b\s+https?:/i,
  /\bregsvr32\b[^|&;]*\/i:\s*https?:/i,
  // Turning script signing off wholesale.
  /\bset-executionpolicy\b[^|&;]*\b(?:bypass|unrestricted)\b/i,
  // Power state, matching the POSIX shutdown/reboot entries above.
  /\b(?:stop-computer|restart-computer)\b/i,
  /\bshutdown\b[^|&;]*\s\/[srfp]\b/i,
];

// Commands whose output is inspection-only and safe to auto-approve in normal
// mode. Interpreters and package-runners (node, python, npx, npm run, …) are
// deliberately NOT here: whitelisting an interpreter is equivalent to
// whitelisting "run any code" (e.g. `node -e '…'`, `python3 -c '…'`), which
// turns prompt injection into silent RCE. Those now require confirmation.
export const SAFE_SHELL_COMMANDS = [
  'ls', 'cat', 'echo', 'pwd', 'which', 'find', 'grep', 'rg',
  'jq', 'head', 'tail', 'wc',
  // Test/build runners are scoped tools, not eval-a-string interpreters.
  'npm test', 'yarn test', 'pytest', 'go test', 'cargo test', 'tsc',
  'git status', 'git log', 'git diff', 'git show',
  'git add', 'git commit', 'git branch',
  'mkdir', 'cp', 'mv', 'touch',
];

/**
 * Inspection-only commands on cmd.exe and PowerShell.
 *
 * Without these the safe list matched nothing a Windows shell runs, so every
 * `dir` and every `type` raised a confirmation. That is not merely annoying:
 * a prompt on each harmless listing trains the user to approve without
 * reading, which is precisely the habit that makes the prompt on a genuinely
 * destructive command worthless.
 *
 * Read-only by construction. Nothing here writes, deletes, or evaluates a
 * string — no powershell/cmd/wmic, for the same reason node and python are
 * absent from the POSIX list above.
 */
export const WINDOWS_SAFE_SHELL_COMMANDS = [
  'dir', 'type', 'findstr', 'where', 'whoami', 'hostname', 'ver', 'tree', 'fc',
  // PowerShell verbs, all Get-* or otherwise non-mutating.
  'get-childitem', 'get-content', 'get-location', 'get-command', 'get-item',
  'get-date', 'get-host', 'select-string', 'measure-object', 'test-path',
  'compare-object', 'resolve-path',
];

/**
 * Fallback model chain tried in order when the primary model exhausts its
 * retries. Empty by default — hardcoding vendor models here silently sent
 * traffic to providers the user never configured (and has no keys for).
 * Set via --fallback flags, AURA_FALLBACK_MODEL, or "fallbacks" in .aura.json.
 */
export const FALLBACK_CHAIN: readonly string[] = [];

export const IGNORE_PATTERNS = [
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.env', '.env.local', '*.lock', 'package-lock.json',
  '*.pyc', '.DS_Store', 'coverage', '.next', '.nuxt',
  '*.min.js', '*.map',
  'google-cloud-sdk', 'graphify-out',
];

export const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.rar',
  '.exe', '.dll', '.so', '.dylib',
  '.wasm', '.ttf', '.woff', '.woff2',
];
