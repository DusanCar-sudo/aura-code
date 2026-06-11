export const DEFAULTS = {
  // No default model — the user picks their own on first run via the wizard.
  // This keeps the codebase provider-agnostic: nothing here assumes a specific vendor.
  defaultModel: undefined as string | undefined,
  maxTokens: 8096,
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
  // Local profile (--profile local / profile: "local" in .rubycode.json)
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
  '> /dev/', 'curl.*|.*sh', 'wget.*|.*sh',
];

export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\b/i,
  /\b(sudo\s+)?rm\s+-rf?\b/i,
  /\bmkfs\b/,
  /\bdd\s+if=/i,
  /\bfdisk\b/,
  /:\(\)\s*\{/,
  />\s*\/dev\//,
  /\|\s*(ba)?sh\b/,
  /\bwget\b.*\|\s*(ba)?sh/i,
  /\bcurl\b.*\|\s*(ba)?sh/i,
  /\bchmod\s+777\b/,
  /\bchown\s+root\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bdrop\s+database\b/i,
  /\btruncate\s+table\b/i,
  /\beval\s*\(/,
  /\bsource\s+\/dev\//,
];

export const SAFE_SHELL_COMMANDS = [
  'ls', 'cat', 'echo', 'pwd', 'which', 'find', 'grep', 'rg',
  'npm test', 'npm run', 'npx', 'yarn test', 'yarn run',
  'python', 'python3', 'pytest', 'go test', 'cargo test',
  'tsc', 'node', 'ts-node',
  'git status', 'git log', 'git diff', 'git show',
  'git add', 'git commit', 'git branch',
  'mkdir', 'cp', 'mv', 'touch',
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
