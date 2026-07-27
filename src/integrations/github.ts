/**
 * GitHub integration via Vercel Connect.
 *
 * Provides app-scoped GitHub tokens and common API operations for agents.
 * On Vercel, VERCEL_OIDC_TOKEN is auto-injected. Locally, run:
 *   vercel env pull .vercel/.env.local
 * to pull it into your environment.
 *
 * Uses dynamic import for @vercel/connect to avoid ESM/CJS module resolution issues.
 */

// @ts-ignore - Dynamic import to handle ESM module
type GetTokenFn = (connector: string, options: { subject: { type: string } }) => Promise<string>;

let connectModule: { getToken: GetTokenFn } | null = null;

async function getConnect() {
  if (!connectModule) {
    // @ts-ignore - Dynamic import to handle ESM module
    const mod = await import('@vercel/connect');
    connectModule = mod as { getToken: GetTokenFn };
  }
  return connectModule as { getToken: GetTokenFn };
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: { login: string };
  description: string | null;
  default_branch: string | null;
  language: string | null;
  updated_at: string;
  url: string;
  html_url: string;
}

export interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  url: string;
}

export interface GitHubPR {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  user: { login: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubFile {
  path: string;
  type: 'file' | 'dir' | 'submodule' | 'symlink';
  size: number | null;
  sha: string;
  url: string;
  html_url?: string;
}

const DEFAULT_CONNECTOR = 'github/byzantine-nest';
const TEAM_ID = 'team_nb0xS8mCtFSZa9RROQQACieQ';

/**
 * Available GitHub connectors in this team.
 * byzantine-nest: milodule3-debug repos (43 repos)
 * dusancar-sudo: DusanCar-sudo repos (46 repos)
 */
export const GITHUB_CONNECTORS = {
  byzantine: 'github/byzantine-nest',
  dusancar: 'github/dusancar-sudo',
} as const;

/**
 * Mint a GitHub app token via Vercel Connect (app-scoped).
 * Fails with helpful error if VERCEL_OIDC_TOKEN is missing.
 */
async function getAppToken(connector: string = DEFAULT_CONNECTOR): Promise<string> {
  if (!process.env.VERCEL_OIDC_TOKEN) {
    throw new Error(
      'VERCEL_OIDC_TOKEN not found. On Vercel it is auto-injected. ' +
      'Locally: run `vercel env pull .vercel/.env.local` from your project dir.'
    );
  }
  const { getToken } = await getConnect();
  return await getToken(connector, { subject: { type: 'app' } });
}

/**
 * Generic GitHub API call helper.
 */
async function githubApi<T>(
  path: string,
  method: string = 'GET',
  body?: any,
  tokenOrConnector?: string,
  isToken: boolean = false
): Promise<T> {
  const authToken = isToken
    ? tokenOrConnector ?? await getAppToken()
    : await getAppToken(tokenOrConnector);
  const url = `https://api.github.com${path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${authToken}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'aura-code-agent',
  };
  if (body) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API ${response.status}: ${error}`);
  }

  return response.json() as T;
}

// ==================== Public API ====================

/**
 * List repositories accessible to the installed GitHub App.
 */
export async function listRepos(connector?: string): Promise<GitHubRepo[]> {
  const result = await githubApi<{ repositories: GitHubRepo[]; total_count: number }>(
    '/installation/repositories', 'GET', undefined, connector
  );
  return result.repositories;
}

/**
 * Get a specific repository by owner/name.
 */
export async function getRepo(owner: string, repo: string, connector?: string): Promise<GitHubRepo> {
  return githubApi<GitHubRepo>(`/repos/${owner}/${repo}`, 'GET', undefined, connector);
}

/**
 * List contents of a directory in a repo.
 */
export async function listContents(
  owner: string,
  repo: string,
  path: string = '',
  ref?: string,
  connector?: string
): Promise<GitHubFile[]> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return githubApi<GitHubFile[]>(`/repos/${owner}/${repo}/contents/${path}${query}`, 'GET', undefined, connector);
}

/**
 * Get file content from a repo (raw string).
 */
export async function getFile(
  owner: string,
  repo: string,
  path: string,
  ref?: string,
  connector?: string
): Promise<string> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const response = await githubApi<{ content: string; encoding: string }>(
    `/repos/${owner}/${repo}/contents/${path}${query}`, 'GET', undefined, connector
  );
  if (response.encoding !== 'base64') {
    throw new Error(`Unsupported encoding: ${response.encoding}`);
  }
  return Buffer.from(response.content, 'base64').toString('utf-8');
}

/**
 * Create or update a file in a repo.
 */
export async function createOrUpdateFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch?: string,
  sha?: string,
  connector?: string
): Promise<{ commit: GitHubCommit; content: GitHubFile }> {
  const body: any = {
    message,
    content: Buffer.from(content).toString('base64'),
  };
  if (branch) body.branch = branch;
  if (sha) body.sha = sha;

  return githubApi<{ commit: GitHubCommit; content: GitHubFile }>(
    `/repos/${owner}/${repo}/contents/${path}`,
    'PUT',
    body,
    connector
  );
}

/**
 * List pull requests for a repo.
 */
export async function listPullRequests(
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open',
  perPage: number = 30,
  connector?: string
): Promise<GitHubPR[]> {
  return githubApi<GitHubPR[]>(
    `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}`,
    'GET',
    undefined,
    connector
  );
}

/**
 * Create a pull request.
 */
export async function createPullRequest(
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body?: string,
  connector?: string
): Promise<GitHubPR> {
  return githubApi<GitHubPR>(
    `/repos/${owner}/${repo}/pulls`,
    'POST',
    { title, head, base, body: body || '' },
    connector
  );
}

/**
 * Add a comment to a pull request or issue.
 */
export async function createComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  connector?: string
): Promise<{ id: number; body: string; user: { login: string } }> {
  return githubApi(
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    'POST',
    { body },
    connector
  );
}

/**
 * List recent commits for a repo.
 */
export async function listCommits(
  owner: string,
  repo: string,
  perPage: number = 30,
  sha?: string,
  connector?: string
): Promise<GitHubCommit[]> {
  const query = `?per_page=${perPage}${sha ? `&sha=${encodeURIComponent(sha)}` : ''}`;
  const raw = await githubApi<any[]>(`/repos/${owner}/${repo}/commits${query}`, 'GET', undefined, connector);
  return raw.map(c => ({
    sha: c.sha,
    message: c.commit?.message ?? '',
    author: c.author?.login ?? c.commit?.author?.name ?? '',
    url: c.html_url,
  }));
}

/**
 * Create a repository (for the authenticated app/installation).
 */
export async function createRepo(
  name: string,
  description?: string,
  isPrivate: boolean = true,
  connector?: string
): Promise<GitHubRepo> {
  return githubApi<GitHubRepo>(
    '/user/repos',
    'POST',
    { name, description, private: isPrivate },
    connector
  );
}

/**
 * Test the connection by fetching a lightweight API response.
 * Returns metadata about the GitHub installation.
 */
export async function testConnection(connector?: string): Promise<{
  ok: boolean;
  installationId?: number;
  reposAccessible?: number;
  error?: string;
}> {
  try {
    const result = await githubApi<{ repositories: any[]; total_count: number }>(
      '/installation/repositories', 'GET', undefined, connector
    );
    return {
      ok: true,
      reposAccessible: result.total_count,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Re-export for direct HTTP API usage if needed
export { githubApi, getAppToken };
