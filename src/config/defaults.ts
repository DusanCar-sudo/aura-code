export const DEFAULTS = {
  // No default model — the user picks their own on first run via the wizard.
  // This keeps the codebase provider-agnostic: nothing here assumes a specific vendor.
  defaultModel: undefined as string | undefined,
  maxTokens: 32000,
  maxContextFiles: 20,
  maxFileLinesInContext: 300,
  maxDirDepth: 4,
  toolTimeout: 30_000,     // 30s max per tool execution
  maxTurns: 150,            // prevent infinite loops
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
