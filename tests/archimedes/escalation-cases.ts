// Shared graded question set for the escalation-correctness benchmark (Task 3).
//
// This module is imported by BOTH harnesses so the 30 cases exist exactly once:
//   - escalation-correctness.test.ts  — grades the VERIFIER in isolation (both planted answers)
//   - escalation-fullpath.test.ts     — runs each case through the FULL Archimedes path
//     (small model + agent loop + verifier) and records token cost per case.
//
// Deterministic grade facts (must / mustAny / mustNot regexes) live in
// escalation-fullpath.test.ts, keyed by case id, so the cases themselves stay a
// single question set for both harnesses.

// ─────────────────────────────────────────────────────────────────────────────
// Case definitions — the graded question set
// ─────────────────────────────────────────────────────────────────────────────

export interface EscalationCase {
  id: string;
  mode: 'retrieval' | 'design';
  /** Whether the small model SHOULD handle this (i.e. accept-correct === right) */
  shouldHandle: boolean;
  task: string;
  /** Recorded tool evidence — what the verifier sees */
  evidence: { name: string; input: Record<string, unknown>; content: string }[];
  /** Known-correct answer — verifier SHOULD accept */
  correctAnswer: string;
  /** Fabricated/wrong answer — verifier SHOULD reject */
  wrongAnswer: string;
}

export const CASES: EscalationCase[] = [
  // ── RETRIEVAL (fact-checking) ──────────────────────────────────────────
  {
    id: 'ret-001-exists',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'What is the value of the MAX_RETRIES constant in src/config.js?',
    evidence: [
      {
        name: 'search_code',
        input: { query: 'MAX_RETRIES' },
        content: 'src/config.js:7: const MAX_RETRIES = 5;',
      },
    ],
    correctAnswer: 'According to src/config.js line 7, MAX_RETRIES is set to 5.',
    wrongAnswer: 'MAX_RETRIES is set to 10, configured in src/settings.js.',
  },
  {
    id: 'ret-002-not-found',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'Does the project have a function named getConnectionPool in src/db/index.js?',
    evidence: [
      {
        name: 'search_code',
        input: { query: 'getConnectionPool' },
        content: 'No results found for "getConnectionPool".',
      },
    ],
    correctAnswer: 'No — searching for getConnectionPool returned no results, so it does not exist in the project.',
    wrongAnswer: 'Yes — getConnectionPool is defined in src/db/index.js and manages pooled connections.',
  },
  {
    id: 'ret-003-contradiction',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'What port does the dev server listen on according to src/server/index.js?',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/server/index.js' },
        content: 'const PORT = process.env.PORT || 3000;',
      },
    ],
    correctAnswer: 'The dev server listens on PORT from the environment, defaulting to 3000.',
    wrongAnswer: 'The dev server listens on port 8080 by default.',
  },
  {
    id: 'ret-004-interface',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'What methods does the AuthService class expose?',
    evidence: [
      {
        name: 'search_code',
        input: { query: 'class AuthService' },
        content: 'src/services/auth.ts:14: export class AuthService { login(); logout(); refresh(); }',
      },
    ],
    correctAnswer: 'AuthService exposes login(), logout(), and refresh().',
    wrongAnswer: 'AuthService exposes register(), verify(), and revoke().',
  },
  {
    id: 'ret-005-version',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'Which version of Node does the project require?',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'package.json' },
        content: '"engines": { "node": ">=18.0.0" }',
      },
    ],
    correctAnswer: 'The project requires Node >= 18.0.0.',
    wrongAnswer: 'The project requires Node >= 16.0.0.',
  },
  {
    id: 'ret-006-plural',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'How many test files are there in the tests directory?',
    evidence: [
      {
        name: 'list_dir',
        input: { path: 'tests' },
        content: 'tests/\n  foo.test.ts\n  bar.test.ts\n  baz.test.ts',
      },
    ],
    correctAnswer: 'There are 3 test files in tests/: foo.test.ts, bar.test.ts, and baz.test.ts.',
    wrongAnswer: 'There are 5 test files in the tests directory.',
  },
  {
    id: 'ret-007-export',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'Is the function processOrder exported from src/order/processor.js?',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/order/processor.js' },
        content: 'export function processOrder(order) { ... }',
      },
    ],
    correctAnswer: 'Yes — processOrder is exported from src/order/processor.js.',
    wrongAnswer: 'No — processOrder is a private function and not exported.',
  },
  {
    id: 'ret-008-flag',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'Is the feature flag ENABLE_BILLING enabled by default?',
    evidence: [
      {
        name: 'search_code',
        input: { query: 'ENABLE_BILLING' },
        content: "src/config/features.js:3: const ENABLE_BILLING = false;",
      },
    ],
    correctAnswer: 'No — ENABLE_BILLING defaults to false in src/config/features.js.',
    wrongAnswer: 'Yes — ENABLE_BILLING is enabled by default.',
  },
  {
    id: 'ret-009-route',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'What is the route path for the health check endpoint?',
    evidence: [
      {
        name: 'search_code',
        input: { query: 'health' },
        content: 'src/routes/health.ts:9: router.get("/health", handler);',
      },
    ],
    correctAnswer: 'The health check endpoint is at GET /health.',
    wrongAnswer: 'The health check endpoint is at GET /status.',
  },
  {
    id: 'ret-010-constant-file',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'Where is the DEFAULT_TIMEOUT constant defined?',
    evidence: [
      {
        name: 'search_code',
        input: { query: 'DEFAULT_TIMEOUT' },
        content: 'src/utils/timeout.ts:5: export const DEFAULT_TIMEOUT = 5000;',
      },
    ],
    correctAnswer: 'DEFAULT_TIMEOUT is defined in src/utils/timeout.ts at line 5.',
    wrongAnswer: 'DEFAULT_TIMEOUT is defined in src/core/constants.ts.',
  },
  {
    id: 'ret-011-missing-method',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'Does the UserRepository class have a findById method?',
    evidence: [
      {
        name: 'search_code',
        input: { query: 'findById' },
        content: 'No results found for "findById".',
      },
    ],
    correctAnswer: 'No — searching for findById returned no results, so UserRepository does not have that method.',
    wrongAnswer: 'Yes — UserRepository.findById() retrieves a user by ID.',
  },
  {
    id: 'ret-012-script',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'What does the "build" npm script run?',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'package.json' },
        content: '"scripts": { "build": "tsc" }',
      },
    ],
    correctAnswer: 'The "build" script runs tsc.',
    wrongAnswer: 'The "build" script runs vitest.',
  },
  {
    id: 'ret-013-definition',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'Where is the interface PaymentGateway defined?',
    evidence: [
      {
        name: 'search_code',
        input: { query: 'interface PaymentGateway' },
        content: 'src/payments/gateway.ts:12: export interface PaymentGateway { ... }',
      },
    ],
    correctAnswer: 'PaymentGateway is defined in src/payments/gateway.ts.',
    wrongAnswer: 'PaymentGateway is defined in src/shared/types.ts.',
  },
  {
    id: 'ret-014-count',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'How many dependencies does the project have?',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'package.json' },
        content: '"dependencies": { "express": "^4.0", "zod": "^3.0", "dotenv": "^16.0" }',
      },
    ],
    correctAnswer: 'The project has 3 dependencies: express, zod, and dotenv.',
    wrongAnswer: 'The project has 7 dependencies.',
  },
  {
    id: 'ret-015-env',
    mode: 'retrieval',
    shouldHandle: true,
    task: 'What environment variable controls the database connection string?',
    evidence: [
      {
        name: 'search_code',
        input: { query: 'DATABASE_URL' },
        content: 'src/config/db.ts:5: const connectionString = process.env.DATABASE_URL;',
      },
    ],
    correctAnswer: 'The DATABASE_URL environment variable controls the database connection string.',
    wrongAnswer: 'The DB_HOST environment variable controls the connection string.',
  },
  // ── DESIGN (proposal) ───────────────────────────────────────────────────
  {
    id: 'des-001-feature',
    mode: 'design',
    shouldHandle: true,
    task: 'Design an approach to add pagination to the user list endpoint.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/routes/users.ts' },
        content: 'router.get("/users", (req, res) => { const users = db.findAll(); res.json(users); });',
      },
    ],
    correctAnswer: 'To add pagination, accept limit/offset query params, pass them to a paginated query, and return { data, page, total }.',
    wrongAnswer: 'Add pagination by switching to a graph database and denormalizing users into a flat table.',
  },
  {
    id: 'des-002-refactor',
    mode: 'design',
    shouldHandle: true,
    task: 'Refactor the duplicated validation logic in createUser and updateUser into a shared helper.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/services/user.ts' },
        content: 'Both createUser and updateUser duplicate the same zod schema validation.',
      },
    ],
    correctAnswer: 'Extract the shared zod schema into a single exported schema and reuse it in both handlers.',
    wrongAnswer: 'Keep the duplication — it is safer to have two independent copies in case they diverge.',
  },
  {
    id: 'des-003-architecture',
    mode: 'design',
    shouldHandle: true,
    task: 'Propose a caching strategy for API responses that change rarely.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/api/cache.ts' },
        content: 'The API currently has no caching layer.',
      },
    ],
    correctAnswer: 'Use a Redis-backed cache with a TTL for rarely-changing responses, keyed by route + query hash, with cache invalidation on writes.',
    wrongAnswer: 'Cache nothing — caching adds complexity with no measurable benefit for a small API.',
  },
  {
    id: 'des-004-auth',
    mode: 'design',
    shouldHandle: true,
    task: 'Design how to add refresh token rotation to the auth flow.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/auth/tokens.ts' },
        content: 'Tokens are JWT access tokens with no refresh mechanism.',
      },
    ],
    correctAnswer: 'Issue a refresh token alongside the access token; on refresh, invalidate the old refresh token and issue a new pair (rotation).',
    wrongAnswer: 'Store access tokens in localStorage and never expire them — simplest possible approach.',
  },
  {
    id: 'des-005-monitoring',
    mode: 'design',
    shouldHandle: true,
    task: 'Recommend how to monitor the health of the background job worker.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/jobs/worker.ts' },
        content: 'The worker runs jobs silently with no metrics or heartbeat.',
      },
    ],
    correctAnswer: 'Expose a /health endpoint with a heartbeat timestamp, emit metrics for job success/failure/latency, and alert on stalled queues.',
    wrongAnswer: 'Add a console.log at the start of each job and watch the logs manually.',
  },
  {
    id: 'des-006-error-handling',
    mode: 'design',
    shouldHandle: true,
    task: 'Design a consistent error-handling strategy for the API.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/middleware/error.ts' },
        content: 'Errors currently bubble up as generic 500 responses.',
      },
    ],
    correctAnswer: 'Add a centralized error middleware that maps known error types to status codes and returns a consistent JSON shape { error, code }.',
    wrongAnswer: 'Wrap every route in try/catch and return the raw stack trace to the client for debugging.',
  },
  {
    id: 'des-007-db-migration',
    mode: 'design',
    shouldHandle: true,
    task: 'Propose a migration approach for adding a new column to a production table.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/db/migrations/' },
        content: 'Migrations run as a single ALTER TABLE at deploy time.',
      },
    ],
    correctAnswer: 'Use an expand/contract migration: add the nullable column first, backfill, deploy code, then enforce NOT NULL and drop the old path.',
    wrongAnswer: 'DROP the table and recreate it with the new schema — it is clean and simple.',
  },
  {
    id: 'des-008-logging',
    mode: 'design',
    shouldHandle: true,
    task: 'Design a structured logging setup for the application.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/logging/index.ts' },
        content: 'Logging uses console.log with string interpolation.',
      },
    ],
    correctAnswer: 'Adopt a structured logger (pino/winston) emitting JSON with correlation IDs and level-filtered destinations.',
    wrongAnswer: 'Add more console.log calls at every function entry and exit point.',
  },
  {
    id: 'des-009-rate-limiting',
    mode: 'design',
    shouldHandle: true,
    task: 'Recommend a rate-limiting approach for the public API.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/middleware/rate-limit.ts' },
        content: 'There is no rate limiting currently.',
      },
    ],
    correctAnswer: 'Apply a sliding-window rate limiter keyed by IP with sensible per-route limits and 429 responses with Retry-After.',
    wrongAnswer: 'Require users to authenticate before every request and block all unauthenticated traffic.',
  },
  {
    id: 'des-010-testing',
    mode: 'design',
    shouldHandle: true,
    task: 'Design a testing strategy for the new payment module.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/payments/index.ts' },
        content: 'The module has no tests yet.',
      },
    ],
    correctAnswer: 'Unit-test the business logic with mocked gateway; integration-test the full flow against a sandbox; add property tests for validation.',
    wrongAnswer: 'Skip tests for now and add them after launch once the behavior is settled.',
  },
  {
    id: 'des-011-config',
    mode: 'design',
    shouldHandle: true,
    task: 'Design a configuration loading strategy for environment-specific settings.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/config/index.ts' },
        content: 'Config is hardcoded constants in the source.',
      },
    ],
    correctAnswer: 'Load config from environment variables with a validated schema (zod), defaulting per environment, fail-fast on missing required vars.',
    wrongAnswer: 'Put all config in a single JSON file committed to the repo and read it at startup.',
  },
  {
    id: 'des-012-microservices',
    mode: 'design',
    shouldHandle: true,
    task: 'Should the notification service be extracted into a separate microservice?',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/notifications/' },
        content: 'The notification logic is ~200 lines inside the monolith.',
      },
    ],
    correctAnswer: 'Not yet — 200 lines does not justify a separate service; extract a module with a clean interface first, and revisit if it grows or scales independently.',
    wrongAnswer: 'Yes — microservices are always better; split it out now regardless of size.',
  },
  {
    id: 'des-013-cache-key',
    mode: 'design',
    shouldHandle: true,
    task: 'Design the cache key scheme for user profile lookups.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/cache/keys.ts' },
        content: 'Cache keys are currently ad-hoc strings.',
      },
    ],
    correctAnswer: 'Use a namespaced key like "user:{id}:profile:v1" with a namespace version for invalidation and a TTL.',
    wrongAnswer: 'Use the user\'s email as the cache key since emails are unique.',
  },
  {
    id: 'des-014-retry',
    mode: 'design',
    shouldHandle: true,
    task: 'Recommend a retry strategy for the external payment provider.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/payments/provider.ts' },
        content: 'Calls fail intermittently with 5xx errors and there is no retry.',
      },
    ],
    correctAnswer: 'Use exponential backoff with jitter and a max retry count, only retrying idempotent operations (with idempotency keys).',
    wrongAnswer: 'Retry immediately 10 times in a tight loop until it succeeds.',
  },
  {
    id: 'des-015-security',
    mode: 'design',
    shouldHandle: true,
    task: 'Design how to securely store API keys used by the service.',
    evidence: [
      {
        name: 'read_file',
        input: { path: 'src/secrets/index.ts' },
        content: 'API keys are hardcoded in the source files.',
      },
    ],
    correctAnswer: 'Load keys from environment variables or a secrets manager, never commit them, and rotate them on a schedule.',
    wrongAnswer: 'Store keys in a .env file committed to the repo so the team always has them available.',
  },
];
