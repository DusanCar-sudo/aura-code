import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface ExternalHarness {
  id: string;
  name: string;
  command: string;
  role: string;
  status: 'available' | 'missing' | 'partial';
  path?: string;
  version?: string;
  notes: string[];
}

export interface HermesStatus {
  home: string;
  workspace: string;
  homeExists: boolean;
  workspaceExists: boolean;
  scripts: string[];
  skills: string[];
  skillCount: number;
  processStateExists: boolean;
  gatewayStateExists: boolean;
}

const HERMES_HOME = process.env.HERMES_HOME ?? '/home/dusanmilosavljevic/.hermes';
const HERMES_WORKSPACE = process.env.HERMES_WORKSPACE ?? '/home/dusanmilosavljevic/hermes-workspace';

const harnesses = [
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    role: 'External terminal coding agent for project-level coding tasks.',
    notes: ['Use as an alternate coding backend.', 'Ruby should pass a project cwd and a bounded prompt.'],
  },
  {
    id: 'openclaude',
    name: 'OpenClaude',
    command: 'openclaude',
    role: 'Claude-style CLI harness for coding and conversational work.',
    notes: ['Useful as a Claude-compatible fallback.', 'Keep secrets in env/config, not in prompts.'],
  },
  {
    id: 'antigravity',
    name: 'Antigravity CLI',
    command: 'agy',
    role: 'Agentic workspace harness with project boundaries, permissions and background workflows.',
    notes: ['Best treated as a workspace runner.', 'Ruby can inspect availability first, then expose launch actions.'],
  },
  {
    id: 'pi',
    name: 'Pi CLI',
    command: 'pi',
    role: 'General AI CLI/client available on this machine.',
    notes: ['Useful for conversational or lightweight delegated tasks.', 'Adapter should stay optional until command contract is confirmed.'],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    command: 'ollama',
    role: 'Local model runtime for offline/local inference.',
    notes: ['Provider already supports ollama/* models.', 'Status may be available even when daemon is stopped.'],
  },
];

export function getHarnessStatus(): ExternalHarness[] {
  return harnesses.map((h) => {
    const found = which(h.command);
    if (!found) return { ...h, status: 'missing' as const, notes: [...h.notes, 'Command not found in PATH.'] };
    const version = getVersion(h.command);
    return {
      ...h,
      status: version ? 'available' as const : 'partial' as const,
      path: found,
      version: version ?? 'installed, version unavailable',
    };
  });
}

export function getHermesStatus(): HermesStatus {
  const homeExists = fs.existsSync(HERMES_HOME);
  const workspaceExists = fs.existsSync(HERMES_WORKSPACE);
  const scriptsDir = path.join(HERMES_HOME, 'scripts');
  const skillsDir = path.join(HERMES_HOME, 'skills');
  const scripts = listFiles(scriptsDir, ['.py', '.sh', '.js', '.ts']).slice(0, 24);
  const skills = listSkillNames(skillsDir);
  return {
    home: HERMES_HOME,
    workspace: HERMES_WORKSPACE,
    homeExists,
    workspaceExists,
    scripts,
    skills: skills.slice(0, 36),
    skillCount: skills.length,
    processStateExists: fs.existsSync(path.join(HERMES_HOME, 'processes.json')),
    gatewayStateExists: fs.existsSync(path.join(HERMES_HOME, 'gateway_state.json')),
  };
}

function which(command: string): string | undefined {
  try {
    return execFileSync('which', [command], { encoding: 'utf8', timeout: 3000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function getVersion(command: string): string | undefined {
  for (const args of [['--version'], ['version'], ['-v']]) {
    try {
      const out = execFileSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
      const version = out.trim().split('\n')[0]?.trim();
      if (version) return version;
    } catch {
      // Try the next conventional version flag.
    }
  }
  return undefined;
}

function listFiles(dir: string, extensions: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function listSkillNames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
