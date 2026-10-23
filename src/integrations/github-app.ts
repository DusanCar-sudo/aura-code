/**
 * Self-hosted GitHub App integration.
 *
 * Authenticates as a GitHub App using an App ID + private key: sign a short-lived
 * RS256 JWT, exchange it for an installation access token, then call the REST API
 * with that token. Unlike `github.ts` (which depends on Vercel Connect and
 * VERCEL_OIDC_TOKEN), this works anywhere — including the self-hosted Aura server
 * that the phone pairs to.
 *
 * The private key lives only on the machine running the agent. The phone talks to
 * the agent's `/api/github` endpoint and never holds the key.
 *
 * Config (env):
 *   GITHUB_APP_ID              — numeric App ID (from the app's settings page).
 *   GITHUB_APP_PRIVATE_KEY     — RSA private key, PEM. "\n" literals are normalized
 *                                to real newlines so the whole key fits on one line.
 *   GITHUB_APP_INSTALLATION_ID — optional; auto-discovered via /app/installations
 *                                when omitted.
 *
 * Callers should gate on isGitHubAppConfigured() and surface a clear message when
 * it returns false rather than throwing mid-request.
 */

import * as crypto from 'crypto';
import type { GitHubRepo, GitHubCommit, GitHubPR, GitHubFile } from './github.js';

// ── Config ───────────────────────────────────────────────────────────────────

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId?: number;
}

export function githubAppConfig(): GitHubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !rawKey) return null;

  const privateKey = normalizePrivateKey(rawKey);
  if (!privateKey) return null;

  const installationIdRaw = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
  const installationId = installationIdRaw ? Number(installationIdRaw) : undefined;

  return {
    appId,
    privateKey,
    installationId: Number.isInteger(installationId) ? installationId : undefined,
  };
}

export function isGitHubAppConfigured(): boolean {
  return githubAppConfig() !== null;
}

/**
 * Accept a PEM either inline (real newlines) or as a single line using "\n"
 * literals, and require the PEM armor. Returns null for anything that is not a
 * recognizable PEM, so a stray value can't be passed to crypto.sign().
 */
function normalizePrivateKey(raw: string): string | null {
  const key = raw.replace(/\\n/g, '\n');
  if (!key.includes('-----BEGIN') || !key.includes('-----END')) return null;
  return key.endsWith('\n') ? key : key + '\n';
}

// ── Auth: RS256 JWT → installation token ─────────────────────────────────────

function signAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  // GitHub requires exp ≤ 10 minutes from iat, and iat within ~60s of now.
  // Back-date iat slightly for clock skew, keep exp inside the window.
  const payload = { iat: now - 60, exp: now + 8 * 60, iss: appId };
  const signingInput = `${toB64url(JSON.stringify(header))}.${toB64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey);
  return `${signingInput}.${toB64url(signature)}`;
}

function toB64url(input: Buffer | string): string {
  return Buffer.from(input as any).toString('base64url');
}

// Cache the minted token so a burst of requests doesn't mint a new token each
// time (GitHub rate-limits token creation). Reuse until a minute before expiry.
let cachedToken: { token: string; expiresAt: number } | null = null;
let cachedInstallationId: number | null = null;

async function getInstallationToken(): Promise<string> {
  const config = githubAppConfig();
  if (!config) {
    throw new Error('GitHub App is not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.');
  }

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  const jwt = signAppJwt(config.appId, config.privateKey);
  const installationId = config.installationId ?? (await discoverInstallationId(jwt));

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'aura-code-github-app',
      },
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub App token mint failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  cachedToken = { token: data.token, expiresAt: Date.parse(data.expires_at) };
  cachedInstallationId = installationId;
  return data.token;
}

async function discoverInstallationId(jwt: string): Promise<number> {
  if (cachedInstallationId) return cachedInstallationId;

  const res = await fetch('https://api.github.com/app/installations', {
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aura-code-github-app',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub App: cannot list installations (${res.status}): ${text.slice(0, 500)}`);
  }

  const installations = (await res.json()) as { id: number; account?: { login?: string } }[];
  if (!installations.length) {
    throw new Error('GitHub App is not installed on any account. Install it first.');
  }
  return installations[0].id;
}

// ── Generic request ──────────────────────────────────────────────────────────

async function githubAppApi<T>(path: string, method: string = 'GET', body?: unknown): Promise<T> {
  const token = await getInstallationToken();
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'aura-code-github-app',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── Operations (mirrors the surface of `github.ts`, self-hosted) ─────────────

export async function listRepos(): Promise<GitHubRepo[]> {
  const result = await githubAppApi<{ repositories: GitHubRepo[]; total_count: number }>(
    '/installation/repositories', 'GET',
  );
  return result.repositories;
}

export async function getRepo(owner: string, repo: string): Promise<GitHubRepo> {
  return githubAppApi<GitHubRepo>(`/repos/${owner}/${repo}`, 'GET');
}

export async function listContents(
  owner: string,
  repo: string,
  path: string = '',
  ref?: string,
): Promise<GitHubFile[]> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return githubAppApi<GitHubFile[]>(`/repos/${owner}/${repo}/contents/${path}${query}`, 'GET');
}

export async function getFile(
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<string> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const response = await githubAppApi<{ content: string; encoding: string }>(
    `/repos/${owner}/${repo}/contents/${path}${query}`, 'GET',
  );
  if (response.encoding !== 'base64') {
    throw new Error(`Unsupported encoding: ${response.encoding}`);
  }
  return Buffer.from(response.content, 'base64').toString('utf-8');
}

export async function createOrUpdateFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch?: string,
  sha?: string,
): Promise<{ commit: GitHubCommit; content: GitHubFile }> {
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
  };
  if (branch) body.branch = branch;
  if (sha) body.sha = sha;

  return githubAppApi<{ commit: GitHubCommit; content: GitHubFile }>(
    `/repos/${owner}/${repo}/contents/${path}`, 'PUT', body,
  );
}

export async function listPullRequests(
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open',
  perPage: number = 30,
): Promise<GitHubPR[]> {
  return githubAppApi<GitHubPR[]>(
    `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}`, 'GET',
  );
}

export async function createPullRequest(
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body?: string,
): Promise<GitHubPR> {
  return githubAppApi<GitHubPR>(
    `/repos/${owner}/${repo}/pulls`, 'POST',
    { title, head, base, body: body || '' },
  );
}

export async function createComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<{ id: number; body: string; user: { login: string } }> {
  return githubAppApi(
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, 'POST', { body },
  );
}

export async function listCommits(
  owner: string,
  repo: string,
  perPage: number = 30,
  sha?: string,
): Promise<GitHubCommit[]> {
  const query = `?per_page=${perPage}${sha ? `&sha=${encodeURIComponent(sha)}` : ''}`;
  const raw = await githubAppApi<any[]>(`/repos/${owner}/${repo}/commits${query}`, 'GET');
  return raw.map((c) => ({
    sha: c.sha,
    message: c.commit?.message ?? '',
    author: c.author?.login ?? c.commit?.author?.name ?? '',
    url: c.html_url,
  }));
}

export async function testConnection(): Promise<{
  ok: boolean;
  installationId?: number;
  reposAccessible?: number;
  error?: string;
}> {
  try {
    await getInstallationToken();
    const result = await githubAppApi<{ repositories: any[]; total_count: number }>(
      '/installation/repositories', 'GET',
    );
    return { ok: true, reposAccessible: result.total_count };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
