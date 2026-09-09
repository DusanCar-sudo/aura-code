import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildTaskGuidance,
  stripTaskGuidance,
  TASK_GUIDANCE_DELIMITER,
} from '../../src/agent/task-guidance.js';
import { buildSystemPrompt } from '../../src/agent/system-prompt.js';
import { selectTools } from '../../src/tools/index.js';
import type { HistoryMessage } from '../../src/providers/types.js';
import type { ProjectContext } from '../../src/agent/context.js';

// Isolate AURA_HOME so the developer's installed plugins (e.g. an always-on
// skill like ponytail) don't leak into these assertions — guidance content
// must be attributable to the task text alone.
let tmpHome = '';
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-guidance-home-'));
  vi.stubEnv('AURA_HOME', tmpHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const user = (content: string): HistoryMessage => ({ role: 'user', content });

/** Domain keyword that classifyDomains() matches, present in every block. */
const DOMAIN_TASK = 'add oauth token validation to the auth middleware';
/** Domain word with no plugin match either. */
const PLAIN_TASK = 'fix the null check in the parser';

function makeCtx(): ProjectContext {
  return {
    root: '/tmp/aura-guidance-test',
    name: 'guidance-test',
    language: 'TypeScript',
    framework: 'Node.js',
    readme: 'readme',
    auraRules: '',
    agentNotes: '',
    tree: 'file.ts',
    config: 'package.json: {}',
    recentCommits: '',
  };
}

describe('buildTaskGuidance', () => {
  it('returns a domain block for a matching task', () => {
    const g = buildTaskGuidance(DOMAIN_TASK);
    expect(g).toContain('Domain expertise');
  });

  it('never returns a domain block for a task no domain matches', () => {
    // Always-on plugin skills may legitimately appear for any task (one is
    // installed in this environment), but domain classification must not fire.
    expect(buildTaskGuidance(PLAIN_TASK)).not.toContain('Domain expertise');
  });
});

describe('stripTaskGuidance', () => {
  it('round-trips: strip(append(task, g)) === task', () => {
    const g = buildTaskGuidance(DOMAIN_TASK);
    expect(g.length).toBeGreaterThan(0);
    const wrapped = `${PLAIN_TASK}${TASK_GUIDANCE_DELIMITER}${g}`;
    expect(stripTaskGuidance(wrapped)).toBe(PLAIN_TASK);
  });

  it('passes through text without the delimiter unchanged', () => {
    expect(stripTaskGuidance('just a task')).toBe('just a task');
    expect(stripTaskGuidance('')).toBe('');
  });
});

describe('buildSystemPrompt invariance', () => {
  it('is byte-identical across calls and carries no domain guidance', () => {
    const ctx = makeCtx();
    const a = buildSystemPrompt(ctx, 'test-provider');
    const b = buildSystemPrompt(ctx, 'test-provider');
    expect(a).toBe(b);
    // The domain checklists moved to task-guidance.ts — the prompt must not
    // contain them for any task.
    expect(a).not.toContain('## Domain expertise');
  });
});

describe('selectTools ignores guidance keywords in history', () => {
  it('guidance appended to a kickoff message does not trigger conditional tools', () => {
    const g = buildTaskGuidance(DOMAIN_TASK);
    expect(g.length).toBeGreaterThan(0);
    const history: HistoryMessage[] = [
      user(`${PLAIN_TASK}${TASK_GUIDANCE_DELIMITER}${g}`),
      user(PLAIN_TASK),
    ];
    const sent = selectTools(PLAIN_TASK, history).map(t => t.name);
    // oauth/token/auth in the guidance would otherwise trip http_request /
    // github-style triggers; the task itself is plain.
    for (const t of ['github', 'http_request', 'mcp']) {
      expect(sent, `${t} should stay gated`).not.toContain(t);
    }
  });
});
