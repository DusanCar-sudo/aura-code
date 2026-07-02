/**
 * Anthropic OAuth PKCE flow - standalone draft for human review.
 *
 * Ported from ~/.hermes/hermes-agent/agent/anthropic_adapter.py
 * (Hermes-native PKCE OAuth flow section) and the token-refresh logic.
 *
 * This is NOT wired into factory.ts or any existing provider registration.
 * It is a draft only.
 *
 * Key functions:
 *   - generatePkce()          -> PKCE code_verifier + code_challenge (S256)
 *   - buildAuthorizationUrl() -> OAuth authorize URL with PKCE challenge
 *   - exchangeCodeForToken()  -> POST authorization code to token endpoint
 *   - refreshOAuthToken()     -> POST refresh_token grant
 *   - readCredentials()       -> Read stored OAuth creds from disk
 *   - writeCredentials()      -> Persist OAuth creds to disk
 *   - runOAuthLogin()         -> Full interactive PKCE flow (CLI)
 *
 * Credentials are stored at ~/.aura/.anthropic_oauth.json
 *
 * Verified against source (grep on anthropic_adapter.py, byte-for-byte):
 *   client_id, redirect_uri, scope all match lines 1371/1381/1382.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';

// -- Constants (matching Anthropic's OAuth infrastructure) -----------

/** Anthropic OAuth client ID - shared across Claude Code, pi-ai, OpenCode, Hermes. */
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/**
 * Token endpoint URLs. platform.claude.com is the primary;
 * console.anthropic.com is the legacy fallback (now 404s on some paths).
 */
const OAUTH_TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
];

/** Redirect URI registered for this client_id (PKCE public client). */
const OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';

/** OAuth scopes requested - inference, profile, and API-key creation. */
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference';

/** Where Aura stores its own OAuth credentials (separate from Hermes/Claude Code). */
function getOauthFilePath(): string {
  return path.join(os.homedir(), '.aura', '.anthropic_oauth.json');
}

/** User-Agent fragment for Claude Code version spoofing. */
const CLAUDE_CODE_VERSION_FALLBACK = '2.1.74';

// -- Types -----------------------------------------------------------

export interface PkcePair {
  /** PKCE code_verifier (random URL-safe base64, 43 chars). */
  verifier: string;
  /** PKCE code_challenge = base64url(sha256(verifier)). */
  challenge: string;
}

export interface OAuthCredentials {
  /** The access token (JWT or opaque bearer token). */
  accessToken: string;
  /** The refresh token (single-use - rotated on each refresh). */
  refreshToken: string;
  /** Expiry as milliseconds since Unix epoch. */
  expiresAtMs: number;
  /** OAuth scopes granted (persisted across refreshes when known). */
  scopes?: string[];
}

interface TokenExchangeResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  scopes?: string[];
}

// -- PKCE: code_verifier / code_challenge (S256) ---------------------

/**
 * Generate a PKCE code_verifier and S256 code_challenge.
 *
 * - verifier: 32 random bytes, base64url-encoded (no padding) = 43 chars
 * - challenge: base64url(sha256(verifier)), no padding
 */
export function generatePkce(): PkcePair {
  const verifier = crypto
    .randomBytes(32)
    .toString('base64url')
    .replace(/=+$/, '');

  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest()
    .toString('base64url')
    .replace(/=+$/, '');

  return { verifier, challenge };
}

// -- Authorization URL construction ----------------------------------

/**
 * Build the Anthropic OAuth authorize URL with PKCE parameters.
 *
 * The user opens this URL in a browser, authenticates with their
 * Claude Pro/Max subscription, and receives an authorization code.
 */
export function buildAuthorizationUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });

  return `https://claude.ai/oauth/authorize?${params.toString()}`;
}

// -- Token exchange (authorization_code grant) -----------------------

/**
 * Exchange an authorization code for tokens.
 *
 * Tries platform.claude.com first, falls back to console.anthropic.com
 * (which may 404 for some deployments but remains as a legacy fallback).
 *
 * @param code     The authorization code from the redirect.
 * @param verifier The PKCE code_verifier that pairs with the challenge.
 * @param state    The OAuth state parameter (for CSRF validation).
 */
export async function exchangeCodeForToken(
  code: string,
  verifier: string,
  state: string,
): Promise<OAuthCredentials> {
  const body = JSON.stringify({
    grant_type: 'authorization_code',
    client_id: OAUTH_CLIENT_ID,
    code,
    state,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: verifier,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `claude-cli/${CLAUDE_CODE_VERSION_FALLBACK} (external, cli)`,
  };

  let lastError: unknown;

  for (const endpoint of OAUTH_TOKEN_URLS) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        lastError = new Error(
          `Token exchange failed at ${endpoint}: HTTP ${resp.status} - ${text.slice(0, 500)}`,
        );
        continue;
      }

      const result = (await resp.json()) as TokenExchangeResponse;

      const accessToken = result.access_token;
      if (!accessToken) {
        throw new Error('Token exchange response missing access_token');
      }

      const expiresIn = result.expires_in ?? 3600;
      const expiresAtMs = Date.now() + expiresIn * 1000;

      return {
        accessToken,
        refreshToken: result.refresh_token ?? '',
        expiresAtMs,
        scopes: result.scope ? result.scope.split(' ') : undefined,
      };
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Token exchange failed on all endpoints');
}

// -- Token refresh (refresh_token grant) -----------------------------

/**
 * Refresh an Anthropic OAuth token using the refresh_token grant.
 *
 * The refresh token is single-use: a successful refresh rotates the
 * pair and invalidates the old refresh token. Callers must persist
 * the returned credentials.
 *
 * Tries both endpoints with JSON body.
 *
 * @param currentRefreshToken The current refresh_token.
 */
export async function refreshOAuthToken(currentRefreshToken: string): Promise<OAuthCredentials> {
  if (!currentRefreshToken) {
    throw new Error('currentRefreshToken is required');
  }

  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: currentRefreshToken,
    client_id: OAUTH_CLIENT_ID,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `claude-cli/${CLAUDE_CODE_VERSION_FALLBACK} (external, cli)`,
  };

  let lastError: unknown;

  for (const endpoint of OAUTH_TOKEN_URLS) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        lastError = new Error(
          `Token refresh failed at ${endpoint}: HTTP ${resp.status} - ${text.slice(0, 500)}`,
        );
        continue;
      }

      const result = (await resp.json()) as TokenExchangeResponse;

      const accessToken = result.access_token;
      if (!accessToken) {
        throw new Error('Refresh response missing access_token');
      }

      const nextRefresh = result.refresh_token || currentRefreshToken;
      const expiresIn = result.expires_in ?? 3600;
      const expiresAtMs = Date.now() + expiresIn * 1000;

      return {
        accessToken,
        refreshToken: nextRefresh,
        expiresAtMs,
        scopes: result.scope ? result.scope.split(' ') : undefined,
      };
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Token refresh failed on all endpoints');
}

// -- Credential persistence (~/.aura/.anthropic_oauth.json) ----------

/**
 * Read Aura's stored OAuth credentials from disk.
 *
 * Returns null if the file does not exist, is not valid JSON,
 * or does not contain an accessToken.
 */
export async function readCredentials(): Promise<OAuthCredentials | null> {
  const filePath = getOauthFilePath();

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const data: StoredCredentials = JSON.parse(raw);

    if (data.accessToken) {
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? '',
        expiresAtMs: data.expiresAtMs ?? 0,
        scopes: data.scopes,
      };
    }
  } catch {
    // File doesn't exist, is unreadable, or invalid JSON - not an error
  }

  return null;
}

/**
 * Write OAuth credentials to disk atomically.
 *
 * Uses a temp-file + rename strategy to avoid corruption from
 * concurrent writers or partial writes.
 *
 * @param creds The credentials to persist.
 */
export async function writeCredentials(creds: OAuthCredentials): Promise<void> {
  const filePath = getOauthFilePath();

  // Read existing file to preserve any extra fields
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    existing = JSON.parse(raw);
  } catch {
    // File doesn't exist yet - start fresh
  }

  const stored: StoredCredentials & Record<string, unknown> = {
    ...existing,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAtMs: creds.expiresAtMs,
  };

  // Preserve previously-stored scopes when not provided in the new creds
  if (creds.scopes) {
    stored.scopes = creds.scopes;
  } else if (existing.scopes) {
    stored.scopes = existing.scopes as string[];
  }

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const tmpPath = filePath + '.tmp.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  const content = JSON.stringify(stored, null, 2);

  try {
    await fs.writeFile(tmpPath, content, { mode: 0o600, flag: 'wx' });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

// -- Token validity check --------------------------------------------

/**
 * Check whether credentials have a non-expired access token.
 *
 * Allows a 60-second buffer before actual expiry to avoid
 * edge-case races where the token expires mid-request.
 */
export function isTokenValid(creds: OAuthCredentials): boolean {
  const { expiresAtMs } = creds;

  if (!expiresAtMs) {
    // No expiry set (managed keys) - valid if token is present
    return Boolean(creds.accessToken);
  }

  // 60-second buffer
  return Date.now() < expiresAtMs - 60_000;
}

// -- Full interactive OAuth PKCE login flow --------------------------

/**
 * Run the full interactive OAuth PKCE login flow.
 *
 * 1. Generate PKCE verifier/challenge + OAuth state
 * 2. Print the authorize URL for the user to open in a browser
 * 3. Prompt for the authorization code (from the redirect URI fragment)
 * 4. Validate CSRF state
 * 5. Exchange the code for tokens
 * 6. Persist credentials to ~/.aura/.anthropic_oauth.json
 *
 * @param options.onAuthUrl  Called with the URL so the caller can display it
 *                           or open a browser. Defaults to console.log.
 * @param options.onPrompt   Called to get user input. Defaults to a readline
 *                           prompt on stdin.
 * @returns The credentials on success, or null if the user cancelled.
 */
export async function runOAuthLogin(options?: {
  onAuthUrl?: (url: string) => void;
  onPrompt?: (message: string) => Promise<string>;
}): Promise<OAuthCredentials | null> {
  const prompt = options?.onPrompt ?? defaultPrompt;
  const showUrl = options?.onAuthUrl ?? ((url: string) => console.log(url));

  const { verifier, challenge } = generatePkce();
  const oauthState = crypto.randomBytes(32).toString('base64url');

  const authUrl = buildAuthorizationUrl(challenge, oauthState);

  showUrl(authUrl);

  const authCode = await prompt('Authorization code: ');
  if (!authCode) {
    console.error('No code entered.');
    return null;
  }

  // Parse code#state from the redirect fragment
  const splits = authCode.split('#');
  const code = splits[0];
  const receivedState = splits.length > 1 ? splits[1] : '';

  // Validate state to prevent CSRF (RFC 6749 section 10.12)
  if (receivedState !== oauthState) {
    console.error('OAuth state mismatch - possible CSRF, aborting.');
    return null;
  }

  try {
    const creds = await exchangeCodeForToken(code, verifier, receivedState);
    await writeCredentials(creds);
    return creds;
  } catch (err) {
    console.error('Token exchange failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// -- Internal helpers ------------------------------------------------

/**
 * Default stdin prompt using Node.js readline.
 */
function defaultPrompt(message: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
