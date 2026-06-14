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

export const DANGEROUS_PATTERNS: RegExp[] = [
  /\b(sudo\s+)?rm\s+-rf?\b/i,          // rm -r / rm -rf (with or without sudo)
  /\bmkfs\b/,
  /\bdd\s+if=/i,
  /\bfdisk\b/,
  /:\(\)\s*\{/,                         // fork bomb
  />\s*\/dev\/(?!null\b|zero\b|random\b|urandom\b|full\b|fd\b|stdout\b|stderr\b)/,  // redirect to device (allow /dev/null etc.)
  /\|\s*(ba)?sh\b/,
  /\bwget\b.*\|\s*(ba)?sh/i,
  /\bcurl\b.*\|\s*(ba)?sh/i,
  /\bchmod\s+777\b/,
  /\bchown\s+root\b/,
  /(?:^|[;&|]+\s*)(?:sudo\s+)?\bshutdown\b/,   // shutdown as actual command, not substring
  /(?:^|[;&|]+\s*)(?:sudo\s+)?\breboot\b/,     // reboot as actual command, not substring
  /\bsource\s+\/dev\//,
];

export const SAFE_SHELL_COMMANDS = [
  'ls', 'cat', 'echo', 'pwd', 'which', 'find', 'grep', 'rg',
  'curl', 'jq', 'head', 'tail', 'wc',
  'npm test', 'npm run', 'npx', 'yarn test', 'yarn run',
  'python', 'python3', 'pytest', 'go test', 'cargo test',
  'tsc', 'node', 'ts-node',
  'git status', 'git log', 'git diff', 'git show',
  'git add', 'git commit', 'git branch',
  'mkdir', 'cp', 'mv', 'touch',
];

/**
 * Default fallback model chain tried in order when the primary model
 * exhausts its retries.  Overridden by --fallback flags or AURA_FALLBACK_MODEL.
 */
export const FALLBACK_CHAIN: readonly string[] = [
  'mimo-v2.5-pro',
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
  'openrouter/deepseek/deepseek-chat',
  'openrouter/minimax/minimax-m2.5',
];

export const IGNORE_PATTERNS = [
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.env', '.env.local', '*.lock', 'package-lock.json',
  '*.pyc', '.DS_Store', 'coverage', '.next', '.nuxt',
  '*.min.js', '*.map',
];

export const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.rar',
  '.exe', '.dll', '.so', '.dylib',
  '.wasm', '.ttf', '.woff', '.woff2',
];
