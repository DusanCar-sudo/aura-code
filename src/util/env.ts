/**
 * Provider-agnostic env-var reader.
 *
 * Tries, in order:
 *   1. The canonical UPPER_SNAKE_CASE var (most SDKs read this)
 *   2. The lowercase variant (some shells / dotenv loaders normalise to this)
 *   3. Common alternates passed as `aliases`
 *
 * Returns `undefined` if none are set, never throws. Returns `undefined`
 * (NOT '') for empty / whitespace / placeholder values, so callers can use
 * the `??` operator and have it fall through to the next fallback.
 */
export function getApiKey(canonical: string, ...aliases: string[]): string | undefined {
  const names = [canonical, canonical.toLowerCase(), ...aliases];
  for (const name of names) {
    const v = process.env[name];
    if (v && v.trim() && v !== 'your_api_key_here') return v;
  }
  return undefined;
}

/**
 * Same idea for non-secret env vars (base URLs, model names).
 * Returns `undefined` for unset / empty / whitespace, so `??` chains work.
 */
export function getEnv(canonical: string, ...aliases: string[]): string | undefined {
  const names = [canonical, canonical.toLowerCase(), ...aliases];
  for (const name of names) {
    const v = process.env[name];
    if (v && v.trim()) return v;
  }
  return undefined;
}
