import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateTrainingData, exportJSONL } from '../../src/ruby/training-data.js';
import type { Episode, TrainingExample } from '../../src/ruby/types.js';
import type { ProjectPerception } from '../../src/perception/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
let epCounter = 0;
function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  epCounter++;
  return {
    id: `ep-${epCounter}`,
    timestamp: Date.now(),
    task: 'Fix the auth bug in core/auth.ts',
    projectRoot: '/fake/project',
    rubyAttempted: true,
    rubySucceeded: false,
    rubyOutput: 'Some broken code...',
    largeModelUsed: 'claude-sonnet-4-5-20251001',
    largeModelOutput: 'function fixedAuth() { return true; }',
    reviewerApproved: true,
    tokensUsed: { ruby: 100, largeModel: 500 },
    durationMs: 8000,
    taskCategory: 'implementation',
    ...overrides,
  };
}

const mockPerception: ProjectPerception = {
  projectRoot: '/fake/project',
  nodes: [],
  edges: [],
  trajectory: {
    vision: 'Build a secure, scalable coding assistant.',
    deprecated: [],
    inProgress: [],
    planned: [],
  },
  constraints: {
    readOnly: ['package-lock.json'],
    strictRules: ['No circular deps in core/', 'All auth code must be reviewed'],
    riskAreas: ['security-critical'],
    testCoverage: [{ module: 'src', coverage: 'high' }],
  },
  extractedAt: Date.now(),
  version: '1.0.0',
};

function assertValidExample(ex: TrainingExample): void {
  expect(typeof ex.instruction).toBe('string');
  expect(ex.instruction.length).toBeGreaterThan(0);
  expect(typeof ex.input).toBe('string');
  expect(typeof ex.output).toBe('string');
  expect(ex.output.length).toBeGreaterThan(0);
  expect(ex.metadata).toBeDefined();
  expect(typeof ex.metadata.projectRoot).toBe('string');
  expect(typeof ex.metadata.taskCategory).toBe('string');
  expect(typeof ex.metadata.timestamp).toBe('number');
}

// ─────────────────────────────────────────────────────────────────────────────
// generateTrainingData
// ─────────────────────────────────────────────────────────────────────────────
describe('generateTrainingData', () => {
  it('filters out episodes where rubyAttempted is false', async () => {
    const episodes = [
      makeEpisode({ rubyAttempted: false, largeModelOutput: 'correct code' }),
      makeEpisode({ rubyAttempted: true, rubySucceeded: false, largeModelOutput: 'correct code' }),
    ];
    const result = await generateTrainingData(episodes, mockPerception);
    expect(result).toHaveLength(1);
  });

  it('filters out episodes where rubySucceeded is true (only failures)', async () => {
    const episodes = [
      makeEpisode({ rubyAttempted: true, rubySucceeded: true, largeModelOutput: 'Ruby did fine' }),
      makeEpisode({ rubyAttempted: true, rubySucceeded: false, largeModelOutput: 'Large model corrected this' }),
    ];
    const result = await generateTrainingData(episodes, mockPerception);
    expect(result).toHaveLength(1);
  });

  it('filters out episodes without largeModelOutput', async () => {
    const episodes = [
      makeEpisode({ rubyAttempted: true, rubySucceeded: false, largeModelOutput: undefined }),
      makeEpisode({ rubyAttempted: true, rubySucceeded: false, largeModelOutput: 'Fixed version' }),
    ];
    const result = await generateTrainingData(episodes, mockPerception);
    expect(result).toHaveLength(1);
    expect(result[0].output).toBe('Fixed version');
  });

  it('filters out episodes where reviewerApproved is false', async () => {
    const episodes = [
      makeEpisode({
        rubyAttempted: true, rubySucceeded: false,
        largeModelOutput: 'Not reviewed', reviewerApproved: false,
      }),
      makeEpisode({
        rubyAttempted: true, rubySucceeded: false,
        largeModelOutput: 'Reviewed and approved', reviewerApproved: true,
      }),
    ];
    const result = await generateTrainingData(episodes, mockPerception);
    expect(result).toHaveLength(1);
    expect(result[0].output).toBe('Reviewed and approved');
  });

  it('returns correct TrainingExample shape', async () => {
    const episode = makeEpisode({
      task: 'Add JWT authentication',
      rubyAttempted: true,
      rubySucceeded: false,
      rubyOutput: 'broken auth code',
      largeModelOutput: 'function authenticate(token) { /* correct */ }',
      reviewerApproved: true,
      projectRoot: '/home/user/my-app',
      taskCategory: 'implementation',
    });
    const result = await generateTrainingData([episode], mockPerception);

    expect(result).toHaveLength(1);
    const ex = result[0];
    assertValidExample(ex);
    expect(ex.output).toBe('function authenticate(token) { /* correct */ }');
    expect(ex.metadata.projectRoot).toBe('/home/user/my-app');
    expect(ex.metadata.taskCategory).toBe('implementation');
  });

  it('instruction includes project vision from perception', async () => {
    const episode = makeEpisode({
      task: 'Fix something',
      rubyAttempted: true, rubySucceeded: false,
      largeModelOutput: 'corrected', reviewerApproved: true,
    });
    const result = await generateTrainingData([episode], mockPerception);
    expect(result[0].instruction).toContain('Build a secure');
  });

  it('instruction includes strict rules from perception', async () => {
    const episode = makeEpisode({
      task: 'Modify auth',
      rubyAttempted: true, rubySucceeded: false,
      largeModelOutput: 'corrected', reviewerApproved: true,
    });
    const result = await generateTrainingData([episode], mockPerception);
    expect(result[0].instruction).toContain('No circular deps');
  });

  it('returns empty array for no qualifying episodes', async () => {
    const episodes = [
      makeEpisode({ rubyAttempted: false }),
      makeEpisode({ rubyAttempted: true, rubySucceeded: true }),
      makeEpisode({ rubyAttempted: true, rubySucceeded: false, largeModelOutput: undefined }),
      makeEpisode({ rubyAttempted: true, rubySucceeded: false, largeModelOutput: 'ok', reviewerApproved: false }),
    ];
    const result = await generateTrainingData(episodes, mockPerception);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty input', async () => {
    const result = await generateTrainingData([], mockPerception);
    expect(result).toEqual([]);
  });

  it('never throws on invalid input (null, undefined)', async () => {
    await expect(
      generateTrainingData(null as unknown as Episode[], mockPerception),
    ).resolves.toEqual([]);
    await expect(
      generateTrainingData(undefined as unknown as Episode[], mockPerception),
    ).resolves.toEqual([]);
  });

  it('input field contains the original task text', async () => {
    const episode = makeEpisode({
      task: 'Add rate limiting middleware to Express',
      rubyAttempted: true, rubySucceeded: false,
      largeModelOutput: 'app.use(rateLimit(...))', reviewerApproved: true,
    });
    const result = await generateTrainingData([episode], mockPerception);
    expect(result[0].input).toBe('Add rate limiting middleware to Express');
  });

  it('metadata includes rubyFailureReason from rubyOutput', async () => {
    const episode = makeEpisode({
      rubyAttempted: true, rubySucceeded: false,
      rubyOutput: 'Ruby produced totally wrong code',
      largeModelOutput: 'correct', reviewerApproved: true,
    });
    const result = await generateTrainingData([episode], mockPerception);
    expect(result[0].metadata.rubyFailureReason).toContain('Ruby output insufficient');
    expect(result[0].metadata.rubyFailureReason).toContain('wrong code');
  });

  it('multiple qualifying episodes all produce examples', async () => {
    const episodes = Array.from({ length: 5 }, (_, i) =>
      makeEpisode({
        task: `Task ${i}`,
        rubyAttempted: true, rubySucceeded: false,
        largeModelOutput: `Output ${i}`, reviewerApproved: true,
      }),
    );
    const result = await generateTrainingData(episodes, mockPerception);
    expect(result).toHaveLength(5);
    for (const ex of result) {
      assertValidExample(ex);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// exportJSONL
// ─────────────────────────────────────────────────────────────────────────────
describe('exportJSONL', () => {
  let tmpDir: string;
  let jsonlPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-td-'));
    jsonlPath = path.join(tmpDir, 'training.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    epCounter = 0;
  });

  const sampleExamples: TrainingExample[] = [
    {
      instruction: 'You are a coding assistant. Build secure software.',
      input: 'Fix the auth bug in core/auth.ts',
      output: 'function login(user) { return jwt.sign(user); }',
      metadata: {
        projectRoot: '/home/app',
        taskCategory: 'implementation',
        timestamp: 1_700_000_000_000,
      },
    },
    {
      instruction: 'You are a coding assistant. Build secure software.',
      input: 'Add rate limiting middleware',
      output: 'app.use(rateLimit({ windowMs: 60000 }));',
      metadata: {
        projectRoot: '/home/app',
        taskCategory: 'implementation',
        rubyFailureReason: 'Ruby produced incorrect limiter scope',
        timestamp: 1_700_000_001_000,
      },
    },
  ];

  it('writes correct JSONL format', async () => {
    await exportJSONL(sampleExamples, jsonlPath);

    expect(fs.existsSync(jsonlPath)).toBe(true);
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('each line is valid JSON', async () => {
    await exportJSONL(sampleExamples, jsonlPath);

    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(parsed.messages).toBeDefined();
      expect(Array.isArray(parsed.messages)).toBe(true);
    }
  });

  it('each line has messages array with user + assistant (2 messages)', async () => {
    await exportJSONL(sampleExamples, jsonlPath);

    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.messages).toHaveLength(2);

      expect(parsed.messages[0].role).toBe('user');
      expect(typeof parsed.messages[0].content).toBe('string');

      expect(parsed.messages[1].role).toBe('assistant');
      expect(typeof parsed.messages[1].content).toBe('string');
    }
  });

  it('user message combines instruction and input', async () => {
    await exportJSONL([sampleExamples[0]], jsonlPath);

    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.messages[0].content).toContain(sampleExamples[0].instruction);
    expect(parsed.messages[0].content).toContain(sampleExamples[0].input);
  });

  it('assistant message contains the large model output', async () => {
    await exportJSONL([sampleExamples[0]], jsonlPath);

    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.messages[1].content).toBe(sampleExamples[0].output);
  });

  it('handles empty examples array', async () => {
    await exportJSONL([], jsonlPath);
    // May create an empty file
    if (fs.existsSync(jsonlPath)) {
      const content = fs.readFileSync(jsonlPath, 'utf8');
      expect(content.trim()).toBe('');
    }
  });

  it('creates parent directories if needed', async () => {
    const deep = path.join(tmpDir, 'deep', 'nested', 'dir', 'output.jsonl');
    await exportJSONL(sampleExamples, deep);
    expect(fs.existsSync(deep)).toBe(true);
  });

  it('never throws on null examples', async () => {
    await expect(
      exportJSONL(null as unknown as TrainingExample[], jsonlPath),
    ).resolves.toBeUndefined();
  });
});
