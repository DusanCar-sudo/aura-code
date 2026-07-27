/**
 * Example: Using the GitHub integration in your agents.
 *
 * Copy relevant functions into your agent code.
 */

import {
  listRepos,
  getRepo,
  getFile,
  createOrUpdateFile,
  listPullRequests,
  createPullRequest,
  createComment,
  testConnection,
  type GitHubRepo,
  type GitHubPR,
} from './github';

// ==================== Example Usage ====================

/**
 * Example: List all repos the GitHub App can access.
 */
async function exampleListRepos() {
  const repos = await listRepos();
  console.log(`Accessible repos: ${repos.length}`);
  for (const repo of repos) {
    console.log(`  - ${repo.full_name} (${repo.private ? 'private' : 'public'})`);
  }
}

/**
 * Example: Get a specific repo.
 */
async function exampleGetRepo(owner: string, repoName: string) {
  const repo = await getRepo(owner, repoName);
  console.log(`Repo: ${repo.full_name}`);
  console.log(`  Default branch: ${repo.default_branch}`);
  console.log(`  Language: ${repo.language}`);
  return repo;
}

/**
 * Example: Read a file from a repo.
 */
async function exampleReadFile(owner: string, repoName: string, path: string) {
  const content = await getFile(owner, repoName, path);
  console.log(`File ${owner}/${repoName}/${path}:\n${content}`);
  return content;
}

/**
 * Example: Create or update a file.
 */
async function exampleWriteFile(
  owner: string,
  repoName: string,
  path: string,
  content: string,
  commitMessage: string,
  branch?: string
) {
  // First, try to get the file to check if it exists (for sha)
  let sha: string | undefined;
  try {
    // You'd need to implement getFileWithSha or use the API directly
    // For now, sha is optional - omit for new files
  } catch {}

  const result = await createOrUpdateFile(
    owner,
    repoName,
    path,
    content,
    commitMessage,
    branch,
    sha // Include sha if updating an existing file
  );
  console.log(`File ${path} committed: ${result.commit.sha}`);
  return result;
}

/**
 * Example: List open PRs.
 */
async function exampleListPRs(owner: string, repoName: string) {
  const prs = await listPullRequests(owner, repoName, 'open');
  console.log(`Open PRs in ${owner}/${repoName}: ${prs.length}`);
  for (const pr of prs) {
    console.log(`  #${pr.number}: ${pr.title} (${pr.state}) by ${pr.user.login}`);
  }
}

/**
 * Example: Create a PR.
 */
async function exampleCreatePR(
  owner: string,
  repoName: string,
  title: string,
  headBranch: string,
  baseBranch: string = 'main',
  description?: string
) {
  const pr = await createPullRequest(owner, repoName, title, headBranch, baseBranch, description);
  console.log(`PR created: ${pr.html_url}`);
  return pr;
}

/**
 * Example: Add a comment to an issue/PR.
 */
async function exampleAddComment(
  owner: string,
  repoName: string,
  issueNumber: number,
  comment: string
) {
  const result = await createComment(owner, repoName, issueNumber, comment);
  console.log(`Comment added: ${result.id}`);
  return result;
}

/**
 * Quick health check: is the GitHub connection working?
 */
async function exampleHealthCheck() {
  const status = await testConnection();
  if (status.ok) {
    console.log(`✓ GitHub connection OK. ${status.reposAccessible} repos accessible.`);
  } else {
    console.error(`✗ GitHub connection failed: ${status.error}`);
  }
  return status;
}

// ==================== Export for use in your agent ====================

export {
  exampleListRepos,
  exampleGetRepo,
  exampleReadFile,
  exampleWriteFile,
  exampleListPRs,
  exampleCreatePR,
  exampleAddComment,
  exampleHealthCheck,
};
