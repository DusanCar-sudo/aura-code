/**
 * GitHub tool for aura agent — Vercel Connect integration.
 *
 * Provides app-scoped GitHub access for repo operations, file I/O, and PR management.
 * Requires VERCEL_OIDC_TOKEN (auto-injected on Vercel, or pull via `vercel env pull`).
 */

import type { ToolDefinition } from '../providers/types.js';
import * as github from '../integrations/github.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition — what the model sees
// ─────────────────────────────────────────────────────────────────────────────

export const GITHUB_DEFINITION: ToolDefinition = {
  name: 'github',
  description:
    'GitHub operations via Vercel Connect (app-scoped). ' +
    'Actions: list_repos, get_repo, list_contents, get_file, create_file, update_file, ' +
    'list_prs, create_pr, add_comment, list_commits. ' +
    'Use for reading/writing GitHub repos, creating PRs, commenting on issues/PRs. ' +
    'Requires VERCEL_OIDC_TOKEN (auto-injected on Vercel, or `vercel env pull` locally). ' +
    'Connectors: byzantine (milodule3-debug, 43 repos) or dusancar (DusanCar-sudo, 46 repos).',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform: list_repos, get_repo, list_contents, get_file, create_file, update_file, list_prs, create_pr, add_comment, list_commits',
      },
      connector: {
        type: 'string',
        description: 'GitHub connector to use: "byzantine" (milodule3-debug repos, default) or "dusancar" (DusanCar-sudo repos)',
      },
      owner: { type: 'string', description: 'Repository owner (e.g., "DusanCar-sudo", "milodule3-debug")' },
      repo: { type: 'string', description: 'Repository name (e.g., "aura-code")' },
      path: { type: 'string', description: 'File or directory path (for get_file, create_file, update_file, list_contents)' },
      ref: { type: 'string', description: 'Git ref (branch, tag, or commit SHA) — optional' },
      content: { type: 'string', description: 'File content (for create_file, update_file)' },
      message: { type: 'string', description: 'Commit message (for create_file, update_file)' },
      branch: { type: 'string', description: 'Branch name (for create_file, update_file, create_pr)' },
      sha: { type: 'string', description: 'File SHA for existing file (for update_file)' },
      state: { type: 'string', description: 'PR state: open, closed, all (for list_prs)' },
      title: { type: 'string', description: 'PR title (for create_pr)' },
      head: { type: 'string', description: 'Head branch for PR (for create_pr)' },
      base: { type: 'string', description: 'Base branch for PR (for create_pr, default: main)' },
      body: { type: 'string', description: 'PR or comment body text (for create_pr, add_comment)' },
      number: { type: 'number', description: 'Issue/PR number (for add_comment)' },
      per_page: { type: 'number', description: 'Results per page (for list_prs, list_commits)' },
      is_private: { type: 'boolean', description: 'Whether repo is private (for create_repo action)' },
      description: { type: 'string', description: 'Repo description (for create_repo action)' },
    },
    required: ['action'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Input types
// ─────────────────────────────────────────────────────────────────────────────

export interface GitHubInput {
  action: string;
  connector?: 'byzantine' | 'dusancar';
  owner?: string;
  repo?: string;
  path?: string;
  ref?: string;
  content?: string;
  message?: string;
  branch?: string;
  sha?: string;
  state?: 'open' | 'closed' | 'all';
  title?: string;
  head?: string;
  base?: string;
  body?: string;
  number?: number;
  per_page?: number;
  is_private?: boolean;
  description?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool executor
// ─────────────────────────────────────────────────────────────────────────────

export async function githubTool(input: GitHubInput): Promise<string> {
  const { action, connector } = input;
  const connectorId = connector === 'dusancar'
    ? github.GITHUB_CONNECTORS.dusancar
    : github.GITHUB_CONNECTORS.byzantine;

  try {
    switch (action) {
      case 'list_repos': {
        const repos = await github.listRepos(connectorId);
        return `GitHub repos (${repos.length} total, connector=${connectorId}):\n${repos.map(r =>
          `  ${r.full_name} (${r.private ? 'private' : 'public'}) ${r.language ? `[${r.language}]` : ''}`
        ).join('\n')}`;
      }

      case 'get_repo': {
        if (!input.owner || !input.repo) return 'Error: get_repo requires owner and repo';
        const repo = await github.getRepo(input.owner, input.repo, connectorId);
        return `Repo: ${repo.full_name}\n` +
          `  Description: ${repo.description || 'none'}\n` +
          `  Language: ${repo.language || 'unknown'}\n` +
          `  Default branch: ${repo.default_branch || 'unknown'}\n` +
          `  Private: ${repo.private}\n` +
          `  Updated: ${repo.updated_at}\n` +
          `  URL: ${repo.html_url}`;
      }

      case 'list_contents': {
        if (!input.owner || !input.repo) return 'Error: list_contents requires owner and repo';
        const items = await github.listContents(input.owner, input.repo, input.path || '', input.ref, connectorId);
        return `Contents of ${input.owner}/${input.repo}${input.path ? '/' + input.path : ''}${input.ref ? '@' + input.ref : ''}:\n${
          items.map(i => `  ${i.type === 'dir' ? '+' : ' '} ${i.path}${i.size !== null ? ` (${i.size} bytes)` : ''}`).join('\n')
        }`;
      }

      case 'get_file': {
        if (!input.owner || !input.repo || !input.path) return 'Error: get_file requires owner, repo, and path';
        const content = await github.getFile(input.owner, input.repo, input.path, input.ref, connectorId);
        const lines = content.split('\n');
        return `File: ${input.owner}/${input.repo}/${input.path}${input.ref ? '@' + input.ref : ''} (${lines.length} lines)\n${
          lines.map((l, i) => `${(i + 1).toString().padStart(4)}: ${l}`).join('\n')
        }`;
      }

      case 'create_file': {
        if (!input.owner || !input.repo || !input.path || !input.content) {
          return 'Error: create_file requires owner, repo, path, and content';
        }
        const result = await github.createOrUpdateFile(
          input.owner, input.repo, input.path, input.content,
          input.message || `Create ${input.path}`, input.branch, undefined, connectorId
        );
        return `File created: ${input.owner}/${input.repo}/${input.path}\n` +
          `  Commit SHA: ${result.commit.sha}\n` +
          `  URL: ${result.content.html_url}`;
      }

      case 'update_file': {
        if (!input.owner || !input.repo || !input.path || !input.content) {
          return 'Error: update_file requires owner, repo, path, content, and sha';
        }
        if (!input.sha) return 'Error: update_file requires sha (file SHA for existing file)';
        const result = await github.createOrUpdateFile(
          input.owner, input.repo, input.path, input.content,
          input.message || `Update ${input.path}`, input.branch, input.sha, connectorId
        );
        return `File updated: ${input.owner}/${input.repo}/${input.path}\n` +
          `  Commit SHA: ${result.commit.sha}\n` +
          `  URL: ${result.content.html_url}`;
      }

      case 'list_prs': {
        if (!input.owner || !input.repo) return 'Error: list_prs requires owner and repo';
        const prs = await github.listPullRequests(
          input.owner, input.repo, input.state || 'open', input.per_page || 30, connectorId
        );
        return `PRs (${prs.length} ${input.state || 'open'}):\n${prs.map(p =>
          `  #${p.number}: ${p.title}\n    State: ${p.state} | Author: ${p.user.login}\n    Branch: ${p.head.ref} → ${p.base.ref}\n    URL: ${p.html_url}`
        ).join('\n')}`;
      }

      case 'create_pr': {
        if (!input.owner || !input.repo || !input.title || !input.head) {
          return 'Error: create_pr requires owner, repo, title, and head';
        }
        const pr = await github.createPullRequest(
          input.owner, input.repo, input.title, input.head,
          input.base || 'main', input.body, connectorId
        );
        return `PR created: ${pr.html_url}\n` +
          `  #${pr.number}: ${pr.title}\n` +
          `  State: ${pr.state} | Author: ${pr.user.login}\n` +
          `  Branches: ${pr.head.ref} → ${pr.base.ref}`;
      }

      case 'add_comment': {
        if (!input.owner || !input.repo || !input.number || !input.body) {
          return 'Error: add_comment requires owner, repo, number, and body';
        }
        const result = await github.createComment(input.owner, input.repo, input.number, input.body, connectorId);
        return `Comment added to ${input.owner}/${input.repo}#${input.number}\n` +
          `  Comment ID: ${result.id}\n` +
          `  Author: ${result.user.login}`;
      }

      case 'list_commits': {
        if (!input.owner || !input.repo) return 'Error: list_commits requires owner and repo';
        const commits = await github.listCommits(
          input.owner, input.repo, input.per_page || 30, input.ref, connectorId
        );
        return `Recent commits (${commits.length}):\n${commits.map(c =>
          `  ${c.sha.slice(0, 8)}: ${c.message.split('\n')[0].slice(0, 80)}\n    Author: ${c.author}`
        ).join('\n')}`;
      }

      case 'test_connection': {
        const status = await github.testConnection(connectorId);
        if (status.ok) {
          return `GitHub connection OK. ${status.reposAccessible} repos accessible.`;
        }
        return `GitHub connection failed: ${status.error}`;
      }

      default:
        return `Error: Unknown action '${action}'. Valid actions: list_repos, get_repo, list_contents, get_file, create_file, update_file, list_prs, create_pr, add_comment, list_commits, test_connection`;
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return `GitHub tool error (${action}): ${err}`;
  }
}
