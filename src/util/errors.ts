/**
 * Unified error type for API calls. All provider SDK errors are normalised
 * into this so retry / circuit-breaker / fallback layers can reason about
 * them uniformly.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly retriable: boolean;
  readonly provider: string;
  readonly retryAfterMs?: number;
  /** Tokens used in the failing request, if known (for TPM tracking) */
  readonly tokens?: { input: number; output: number };
  /** Cause chain — original SDK error preserved for debugging */
  readonly cause?: unknown;

  constructor(opts: {
    message: string;
    status?: number;
    retriable?: boolean;
    provider: string;
    retryAfterMs?: number;
    tokens?: { input: number; output: number };
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.status = opts.status ?? 0;
    this.retriable = opts.retriable ?? defaultRetriable(opts.status ?? 0);
    this.provider = opts.provider;
    this.retryAfterMs = opts.retryAfterMs;
    this.tokens = opts.tokens;
    this.cause = opts.cause;
  }
}

/**
 * Classify an HTTP status as retriable. 429 and 5xx are retriable; 4xx (except 429) are not.
 * Network errors (status 0) default to retriable.
 */
export function defaultRetriable(status: number): boolean {
  if (status === 0) return true;          // network/timeout
  if (status === 429) return true;        // rate limited
  if (status === 408) return true;        // request timeout
  if (status === 529) return true;        // Anthropic overloaded
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * Normalise any error from any provider SDK into an ApiError. We inspect the
 * error shape, pull out the HTTP status, and read Retry-After if present.
 */
export function normaliseError(e: unknown, provider: string): ApiError {
  // Already normalised
  if (e instanceof ApiError) return e;

  // Anthropic / OpenAI / Google SDKs all throw errors with a `status` and sometimes `headers`.
  const err = e as {
    status?: number;
    statusCode?: number;
    code?: string;
    message?: string;
    headers?: Record<string, string>;
    name?: string;
    errorDetails?: Array<{ '@type'?: string; retryDelay?: string; RetryInfo?: { retryDelay?: string } }>;
  };

  const status = err.status ?? err.statusCode ?? 0;
  const message = err.message ?? String(e);
  const retryAfterMs = parseRetryAfter(err.headers) ?? parseGoogleRetryAfter(err.errorDetails);

  // Network/timeout: status 0
  const isNetwork = status === 0 || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND' || err.name === 'AbortError';

  return new ApiError({
    message: isNetwork ? `Network error: ${message}` : `HTTP ${status}: ${message}`,
    status: isNetwork ? 0 : status,
    retriable: isNetwork || defaultRetriable(status),
    provider,
    retryAfterMs,
    cause: e,
  });
}

function parseRetryAfter(headers?: Record<string, string>): number | undefined {
  if (!headers) return undefined;
  const v = headers['retry-after'] ?? headers['Retry-After'] ?? headers['x-ratelimit-reset'];
  if (!v) return undefined;
  // Could be "120" (seconds) or an HTTP date
  const seconds = Number(v);
  if (!isNaN(seconds)) return Math.round(seconds * 1000);
  const date = Date.parse(v);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Google Gemini's error responses include an `errorDetails` array. The relevant
 * entry has `@type: type.googleapis.com/google.rpc.RetryInfo` and a `retryDelay`
 * string like "27s". We parse it into milliseconds.
 */
function parseGoogleRetryAfter(
  details?: Array<{ '@type'?: string; retryDelay?: string; RetryInfo?: { retryDelay?: string } }>,
): number | undefined {
  if (!details || details.length === 0) return undefined;
  for (const d of details) {
    const type = d['@type'] ?? '';
    if (type.includes('RetryInfo')) {
      const raw = d.retryDelay ?? d.RetryInfo?.retryDelay;
      if (!raw) continue;
      // Formats: "27s", "1500ms", "27.5s"
      const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)(ms|s)?$/);
      if (m) {
        const n = parseFloat(m[1]);
        const unit = m[2] ?? 's';
        return Math.round(unit === 'ms' ? n : n * 1000);
      }
    }
  }
  return undefined;
}

/** Did the error come from Gemini specifically? */
export function isGoogle(e: unknown): boolean {
  if (e instanceof ApiError) return e.provider === 'Google';
  const err = e as { message?: string; name?: string };
  return Boolean(err.message?.includes('GoogleGenerativeAI') || err.name?.includes('GoogleGenerative'));
}
