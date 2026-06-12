import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { loadReport } from './weakness-miner.js';
import type { PatternName, WeaknessReport } from './weakness-miner.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HarnessProposal {
  id: string;
  pattern: PatternName;
  description: string;
  /** Section of system-prompt.ts to modify */
  targetSection: string;
  /** Exact text to insert (a markdown bullet) */
  patchText: string;
  /** Text in the target section used to locate the insertion point */
  anchorText: string;
  createdAt: string;
  status: 'proposed' | 'applied' | 'reverted';
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch registry — maps each pattern to a section + anchor in system-prompt.ts
// ─────────────────────────────────────────────────────────────────────────────

interface PatchEntry {
  section: string;
  anchor: string;
  patch: string;
}

const PATCH_REGISTRY: Partial<Record<PatternName, PatchEntry>> = {
  'no-tool-calls': {
    section: '## How you operate',
    anchor: '- When done, summarize exactly what you changed and why.',
    patch: '- Never respond to a task with only prose. Always begin by using at least one tool (search_code, read_file, or list_dir) to investigate the codebase before summarizing or concluding. A response with zero tool calls is almost always incomplete.',
  },
  'file-not-created': {
    section: '## How you operate',
    anchor: '- If a tool returns an error, read the error carefully and adjust.',
    patch: '- After calling write_file, verify the file exists by reading it back or checking with list_dir. If write_file fails, diagnose the error (permission, missing parent dir) and retry with the fix. Never move on after a failed write without attempting recovery.',
  },
  'explored-not-executed': {
    section: '## How you operate',
    anchor: '- When done, summarize exactly what you changed and why.',
    patch: '- If the task requires a code change, you must eventually call write_file or edit_file to apply it. Do not spend all turns on read_file and search_code — at some point you must commit to making the change. Aim for a 2:1 ratio of reads to writes, not 100% reads.',
  },
  'test-regression': {
    section: '## How you operate',
    anchor: '- After making changes, run_tests to verify nothing broke.',
    patch: '- When run_tests reports new failures you did not expect, immediately investigate and fix them before proceeding. Never leave the codebase in a state with more test failures than you started with. If you introduced a regression, roll back your change or fix it before moving on.',
  },
  'loop-exhausted': {
    section: '## How you operate',
    anchor: '- When done, summarize exactly what you changed and why.',
    patch: '- Work efficiently. Do not repeat the same tool calls. If you have made 3+ attempts at the same approach without progress, try a fundamentally different strategy. Prioritize completing the task over perfect completion — a working partial solution is better than an exhausted loop.',
  },
  'safety-false-positive': {
    section: '## Safety',
    anchor: '- If a command seems destructive, explain what it does and ask for confirmation.',
    patch: '- The safety system may occasionally block harmless commands (mkdir, ls, touch, cp, etc.). If a common file-manipulation command is blocked, try using write_file or edit_file as an alternative, or explain in your response that the safety layer is being overly cautious.',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

export function proposalsDir(): string {
  return path.join(process.env.HOME ?? '/tmp', '.rubycode', 'harness', 'proposals');
}

function proposalPath(id: string): string {
  return path.join(proposalsDir(), `${id}.json`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate proposals
// ─────────────────────────────────────────────────────────────────────────────

export function generateProposals(reportPath?: string): HarnessProposal[] {
  const report: WeaknessReport | null = loadReport(reportPath);
  if (!report) return [];

  const proposals: HarnessProposal[] = [];

  for (const p of report.patterns) {
    const entry = PATCH_REGISTRY[p.pattern];
    if (!entry) continue;

    const id = `patch-${Date.now()}-${p.pattern}`;
    const proposal: HarnessProposal = {
      id,
      pattern: p.pattern,
      description: p.description,
      targetSection: entry.section,
      patchText: entry.patch,
      anchorText: entry.anchor,
      createdAt: new Date().toISOString(),
      status: 'proposed',
    };

    const outDir = proposalsDir();
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(proposalPath(id), JSON.stringify(proposal, null, 2), 'utf8');
    proposals.push(proposal);
  }

  return proposals;
}

// ─────────────────────────────────────────────────────────────────────────────
// List proposals
// ─────────────────────────────────────────────────────────────────────────────

export function listProposals(): HarnessProposal[] {
  const dir = proposalsDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const proposals: HarnessProposal[] = [];

  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      proposals.push(JSON.parse(raw) as HarnessProposal);
    } catch {
      // Skip malformed files
    }
  }

  return proposals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply a proposal (with rollback on test failure)
// ─────────────────────────────────────────────────────────────────────────────

export function defaultSystemPromptPath(): string {
  return path.join(process.cwd(), 'src', 'agent', 'system-prompt.ts');
}

export function applyHarnessProposal(
  id: string,
  opts: { systemPromptPath?: string; proposalsDir?: string; testCommand?: string } = {},
): { success: boolean; message: string } {
  const dir = opts.proposalsDir ?? proposalsDir();
  const filePath = path.join(dir, `${id}.json`);

  // 1. Load proposal
  if (!fs.existsSync(filePath)) {
    return { success: false, message: `Proposal not found: ${id}` };
  }

  let proposal: HarnessProposal;
  try {
    proposal = JSON.parse(fs.readFileSync(filePath, 'utf8')) as HarnessProposal;
  } catch {
    return { success: false, message: `Invalid proposal file: ${filePath}` };
  }

  // 2. Read system-prompt.ts
  const promptPath = opts.systemPromptPath ?? defaultSystemPromptPath();
  if (!fs.existsSync(promptPath)) {
    return { success: false, message: `System prompt not found: ${promptPath}` };
  }

  const original = fs.readFileSync(promptPath, 'utf8');

  // 3. Find the anchor and insert the patch after it
  const anchorIdx = original.indexOf(proposal.anchorText);
  if (anchorIdx === -1) {
    return { success: false, message: `Anchor text not found in system prompt: "${proposal.anchorText.slice(0, 60)}..."` };
  }

  const insertPos = anchorIdx + proposal.anchorText.length;
  const patched = original.slice(0, insertPos) + '\n' + proposal.patchText + original.slice(insertPos);

  // 4. Write patched file
  fs.writeFileSync(promptPath, patched, 'utf8');

  // 5. Update proposal status
  proposal.status = 'applied';
  fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2), 'utf8');

  // 6. Run tests
  const testCmd = opts.testCommand ?? 'npm test 2>&1';
  let testsPassed = false;
  try {
    const output = execSync(testCmd, {
      encoding: 'utf8',
      timeout: 120_000,
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Check for failures in output — look for non-zero failure counts
    const hasFailure = /[1-9]\d* tests? (fail|failed|failing)/i.test(output) ||
      /FAIL\s/i.test(output) ||
      /Tests:.*\s[1-9]\d*\s+failed/i.test(output);
    testsPassed = !hasFailure;
  } catch {
    // Non-zero exit code = test failure
    testsPassed = false;
  }

  // 7. Revert if tests failed
  if (!testsPassed) {
    fs.writeFileSync(promptPath, original, 'utf8');
    proposal.status = 'reverted';
    fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2), 'utf8');
    return { success: false, message: 'Tests failed after patch — reverted.' };
  }

  return { success: true, message: `Patch applied: ${proposal.pattern} → ${proposal.targetSection}` };
}
