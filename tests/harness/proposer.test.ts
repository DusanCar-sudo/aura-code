import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  generateProposals,
  listProposals,
  applyHarnessProposal,
  proposalsDir,
  defaultSystemPromptPath,
  type HarnessProposal,
} from '../../src/harness/proposer.js';
import { saveReport, type WeaknessReport, type PatternReport } from '../../src/harness/weakness-miner.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proposer-test-'));
}

/** Minimal system-prompt.ts content for apply tests */
const SAMPLE_PROMPT = `import type { ProjectContext } from './context.js';

export function buildSystemPrompt(ctx: ProjectContext, providerName: string): string {
  return \`You are BootstrapRuby — a precise, efficient AI coding agent.

## How you operate
- You work in a loop: read context → plan → execute tools → verify → repeat until done.
- Always READ files before EDITING them. Never guess at file structure.
- After making changes, run_tests to verify nothing broke.
- If a tool returns an error, read the error carefully and adjust.
- When done, summarize exactly what you changed and why.

## Code standards
- Match the existing code style: indentation, naming conventions, comment style.
- Add or update tests when you modify logic.

## Safety
- Never delete files unless explicitly instructed.
- If a command seems destructive, explain what it does and ask for confirmation.

## Project context
Language: \${ctx.language}
\`;
}
`;

function makeReport(patterns: PatternReport[]): WeaknessReport {
  return {
    generatedAt: new Date().toISOString(),
    sessionsAnalyzed: 10,
    patterns,
    summary: `Found ${patterns.length} pattern(s).`,
  };
}

function makePattern(name: PatternReport['pattern'], freq = 3): PatternReport {
  return {
    pattern: name,
    frequency: freq,
    description: `Test pattern: ${name}`,
    occurrences: Array.from({ length: freq }, (_, i) => ({
      sessionId: `ses-${i}`,
      sessionTitle: `Session ${i}`,
      exampleTask: `Task for ${name} #${i}`,
      exampleFailure: `Failure in ${name} #${i}`,
      timestamp: new Date().toISOString(),
    })),
    promptPatch: `PATCH: Add to system prompt — "Test patch for ${name}"`,
  };
}

describe('harness proposer', () => {
  let tmpDir: string;
  let propDir: string;
  let reportFile: string;
  let promptFile: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    propDir = path.join(tmpDir, 'proposals');
    reportFile = path.join(tmpDir, 'weakness-report.json');
    promptFile = path.join(tmpDir, 'system-prompt.ts');
    fs.mkdirSync(propDir, { recursive: true });
    fs.writeFileSync(promptFile, SAMPLE_PROMPT, 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Generation ────────────────────────────────────────────────────────────

  it('generates proposals from a weakness report', () => {
    const report = makeReport([
      makePattern('no-tool-calls'),
      makePattern('test-regression'),
    ]);
    saveReport(report, reportFile);

    const proposals = generateProposals(reportFile);
    expect(proposals).toHaveLength(2);
    expect(proposals[0].pattern).toBe('no-tool-calls');
    expect(proposals[0].targetSection).toBe('## How you operate');
    expect(proposals[0].patchText).toContain('Never respond to a task with only prose');
    expect(proposals[0].status).toBe('proposed');
    expect(proposals[0].id).toMatch(/^patch-\d+-/);
  });

  it('saves proposals as individual JSON files', () => {
    const report = makeReport([makePattern('loop-exhausted')]);
    saveReport(report, reportFile);

    // Override proposalsDir via env for isolation
    const origEnv = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const proposals = generateProposals(reportFile);
      expect(proposals).toHaveLength(1);

      const savedPath = path.join(proposalsDir(), `${proposals[0].id}.json`);
      expect(fs.existsSync(savedPath)).toBe(true);

      const loaded = JSON.parse(fs.readFileSync(savedPath, 'utf8')) as HarnessProposal;
      expect(loaded.pattern).toBe('loop-exhausted');
      expect(loaded.anchorText).toBe('- When done, summarize exactly what you changed and why.');
    } finally {
      process.env.HOME = origEnv;
    }
  });

  it('maps safety-false-positive to ## Safety section', () => {
    const report = makeReport([makePattern('safety-false-positive')]);
    saveReport(report, reportFile);

    const proposals = generateProposals(reportFile);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].targetSection).toBe('## Safety');
    expect(proposals[0].patchText).toContain('safety system may occasionally block');
  });

  it('returns empty array when no report exists', () => {
    const proposals = generateProposals(path.join(tmpDir, 'nonexistent.json'));
    expect(proposals).toHaveLength(0);
  });

  it('returns empty array when report has no patterns', () => {
    const report = makeReport([]);
    saveReport(report, reportFile);

    const proposals = generateProposals(reportFile);
    expect(proposals).toHaveLength(0);
  });

  it('returns empty array when report has no recognized patterns', () => {
    // A report with a pattern that's not in PATCH_REGISTRY
    const report = makeReport([]);
    (report as any).patterns = [{
      pattern: 'unknown-pattern',
      frequency: 5,
      description: 'Unknown',
      occurrences: [],
      promptPatch: 'PATCH: Do something',
    }];
    saveReport(report, reportFile);

    const proposals = generateProposals(reportFile);
    expect(proposals).toHaveLength(0);
  });

  // ── Listing ───────────────────────────────────────────────────────────────

  it('lists saved proposals', () => {
    const proposal: HarnessProposal = {
      id: 'test-1',
      pattern: 'no-tool-calls',
      description: 'Test',
      targetSection: '## How you operate',
      patchText: '- Test patch',
      anchorText: '- When done, summarize exactly what you changed and why.',
      createdAt: new Date().toISOString(),
      status: 'proposed',
    };

    const origEnv = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      // Write to the actual path listProposals() will scan
      const dir = proposalsDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'test-1.json'), JSON.stringify(proposal));

      const listed = listProposals();
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe('test-1');
    } finally {
      process.env.HOME = origEnv;
    }
  });

  it('returns empty array when proposals dir does not exist', () => {
    const origEnv = process.env.HOME;
    process.env.HOME = path.join(tmpDir, 'no-such-dir');
    try {
      const listed = listProposals();
      expect(listed).toHaveLength(0);
    } finally {
      process.env.HOME = origEnv;
    }
  });

  // ── Applying ──────────────────────────────────────────────────────────────

  it('applies a patch and inserts after anchor text', () => {
    const proposal: HarnessProposal = {
      id: 'apply-test-1',
      pattern: 'no-tool-calls',
      description: 'Test',
      targetSection: '## How you operate',
      patchText: '- CUSTOM PATCH: Always start with a tool call.',
      anchorText: '- When done, summarize exactly what you changed and why.',
      createdAt: new Date().toISOString(),
      status: 'proposed',
    };
    fs.writeFileSync(path.join(propDir, `${proposal.id}.json`), JSON.stringify(proposal));

    const result = applyHarnessProposal(proposal.id, {
      systemPromptPath: promptFile,
      proposalsDir: propDir,
      testCommand: 'echo "0 tests passed, 0 failed"',  // mock passing tests
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('Patch applied');

    const patched = fs.readFileSync(promptFile, 'utf8');
    expect(patched).toContain('- CUSTOM PATCH: Always start with a tool call.');
    // Anchor should still be there
    expect(patched).toContain('- When done, summarize exactly what you changed and why.');
  });

  it('reverts patch when tests fail (non-zero exit)', () => {
    const proposal: HarnessProposal = {
      id: 'revert-test-1',
      pattern: 'test-regression',
      description: 'Test',
      targetSection: '## How you operate',
      patchText: '- CUSTOM PATCH: Check for regressions.',
      anchorText: '- After making changes, run_tests to verify nothing broke.',
      createdAt: new Date().toISOString(),
      status: 'proposed',
    };
    fs.writeFileSync(path.join(propDir, `${proposal.id}.json`), JSON.stringify(proposal));

    const result = applyHarnessProposal(proposal.id, {
      systemPromptPath: promptFile,
      proposalsDir: propDir,
      testCommand: 'exit 1',  // mock failing tests
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('reverted');

    // File should be unchanged
    const content = fs.readFileSync(promptFile, 'utf8');
    expect(content).not.toContain('CUSTOM PATCH');
    expect(content).toBe(SAMPLE_PROMPT);

    // Proposal status should be reverted
    const savedProposal = JSON.parse(
      fs.readFileSync(path.join(propDir, `${proposal.id}.json`), 'utf8'),
    ) as HarnessProposal;
    expect(savedProposal.status).toBe('reverted');
  });

  it('reverts patch when tests report failures in output', () => {
    const proposal: HarnessProposal = {
      id: 'revert-test-2',
      pattern: 'loop-exhausted',
      description: 'Test',
      targetSection: '## How you operate',
      patchText: '- CUSTOM PATCH: Work more efficiently.',
      anchorText: '- When done, summarize exactly what you changed and why.',
      createdAt: new Date().toISOString(),
      status: 'proposed',
    };
    fs.writeFileSync(path.join(propDir, `${proposal.id}.json`), JSON.stringify(proposal));

    const result = applyHarnessProposal(proposal.id, {
      systemPromptPath: promptFile,
      proposalsDir: propDir,
      testCommand: 'echo "3 tests failed out of 100"',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('reverted');

    const content = fs.readFileSync(promptFile, 'utf8');
    expect(content).toBe(SAMPLE_PROMPT);
  });

  it('does not revert when tests report 0 failures', () => {
    const proposal: HarnessProposal = {
      id: 'pass-test-1',
      pattern: 'file-not-created',
      description: 'Test',
      targetSection: '## How you operate',
      patchText: '- CUSTOM PATCH: Verify file creation.',
      anchorText: '- If a tool returns an error, read the error carefully and adjust.',
      createdAt: new Date().toISOString(),
      status: 'proposed',
    };
    fs.writeFileSync(path.join(propDir, `${proposal.id}.json`), JSON.stringify(proposal));

    const result = applyHarnessProposal(proposal.id, {
      systemPromptPath: promptFile,
      proposalsDir: propDir,
      testCommand: 'echo "0 tests failed, 100 passed"',
    });

    expect(result.success).toBe(true);

    const content = fs.readFileSync(promptFile, 'utf8');
    expect(content).toContain('CUSTOM PATCH: Verify file creation');
  });

  // ── Error cases ───────────────────────────────────────────────────────────

  it('fails gracefully when proposal does not exist', () => {
    const result = applyHarnessProposal('nonexistent-id', {
      systemPromptPath: promptFile,
      proposalsDir: propDir,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Proposal not found');
  });

  it('fails gracefully when system-prompt.ts does not exist', () => {
    const proposal: HarnessProposal = {
      id: 'missing-prompt',
      pattern: 'no-tool-calls',
      description: 'Test',
      targetSection: '## How you operate',
      patchText: '- Test',
      anchorText: '- When done, summarize exactly what you changed and why.',
      createdAt: new Date().toISOString(),
      status: 'proposed',
    };
    fs.writeFileSync(path.join(propDir, `${proposal.id}.json`), JSON.stringify(proposal));

    const result = applyHarnessProposal(proposal.id, {
      systemPromptPath: path.join(tmpDir, 'nonexistent.ts'),
      proposalsDir: propDir,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('System prompt not found');
  });

  it('fails gracefully when anchor text is not found', () => {
    const proposal: HarnessProposal = {
      id: 'bad-anchor',
      pattern: 'no-tool-calls',
      description: 'Test',
      targetSection: '## How you operate',
      patchText: '- Test',
      anchorText: 'THIS TEXT DOES NOT EXIST IN THE PROMPT',
      createdAt: new Date().toISOString(),
      status: 'proposed',
    };
    fs.writeFileSync(path.join(propDir, `${proposal.id}.json`), JSON.stringify(proposal));

    const result = applyHarnessProposal(proposal.id, {
      systemPromptPath: promptFile,
      proposalsDir: propDir,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Anchor text not found');
  });

  // ── Multiple patches ──────────────────────────────────────────────────────

  it('can apply multiple patches sequentially', () => {
    const proposals: HarnessProposal[] = [
      {
        id: 'multi-1',
        pattern: 'no-tool-calls',
        description: 'Test 1',
        targetSection: '## How you operate',
        patchText: '- PATCH A: First patch.',
        anchorText: '- When done, summarize exactly what you changed and why.',
        createdAt: new Date().toISOString(),
        status: 'proposed',
      },
      {
        id: 'multi-2',
        pattern: 'test-regression',
        description: 'Test 2',
        targetSection: '## How you operate',
        patchText: '- PATCH B: Second patch.',
        anchorText: '- After making changes, run_tests to verify nothing broke.',
        createdAt: new Date().toISOString(),
        status: 'proposed',
      },
    ];

    for (const p of proposals) {
      fs.writeFileSync(path.join(propDir, `${p.id}.json`), JSON.stringify(p));
    }

    const mockTest = 'echo "All 100 tests passed"';

    const r1 = applyHarnessProposal('multi-1', {
      systemPromptPath: promptFile,
      proposalsDir: propDir,
      testCommand: mockTest,
    });
    expect(r1.success).toBe(true);

    const r2 = applyHarnessProposal('multi-2', {
      systemPromptPath: promptFile,
      proposalsDir: propDir,
      testCommand: mockTest,
    });
    expect(r2.success).toBe(true);

    const final = fs.readFileSync(promptFile, 'utf8');
    expect(final).toContain('- PATCH A: First patch.');
    expect(final).toContain('- PATCH B: Second patch.');
  });

  // ── proposalsDir ──────────────────────────────────────────────────────────

  it('proposalsDir returns a valid path', () => {
    const dir = proposalsDir();
    expect(dir).toContain('.rubycode');
    expect(dir).toContain('proposals');
  });

  it('defaultSystemPromptPath returns a valid path', () => {
    const p = defaultSystemPromptPath();
    expect(p).toContain('system-prompt.ts');
  });
});
