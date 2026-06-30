import { describe, it, expect } from 'vitest';
import {
  assessCompetence,
  updateCompetence,
  getCompetenceReport,
  shouldFineTune,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MIN_FAILURES,
} from '../../src/ruby/competence.js';
import { DEFAULT_RUBY_CONFIG } from '../../src/ruby/types.js';
import type {
  AlternationDecision,
  CompetenceLevel,
  Episode,
  RubyConfig,
} from '../../src/ruby/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a minimal Episode with sensible defaults. */
function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: `ep-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    task: 'Fix the auth bug in core/auth.ts',
    projectRoot: '/fake/project',
    rubyAttempted: true,
    rubySucceeded: false,
    reviewerApproved: false,
    tokensUsed: {},
    durationMs: 5000,
    taskCategory: 'implementation',
    ...overrides,
  };
}

/** Validate an AlternationDecision has all required shape guarantees. */
function assertValidDecision(d: AlternationDecision): void {
  expect(d).toBeDefined();
  expect(typeof d.useRuby).toBe('boolean');
  expect(typeof d.reason).toBe('string');
  expect(d.reason.length).toBeGreaterThan(0);
  expect(typeof d.confidence).toBe('number');
  expect(d.confidence).toBeGreaterThanOrEqual(0);
  expect(d.confidence).toBeLessThanOrEqual(1);
  expect(typeof d.fallbackModel).toBe('string');
  expect(d.fallbackModel.length).toBeGreaterThan(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// assessCompetence
// ─────────────────────────────────────────────────────────────────────────────
describe('assessCompetence', () => {
  const config: RubyConfig = { ...DEFAULT_RUBY_CONFIG };
  // minAttempts = 3, competenceThreshold = 0.7

  // ── Empty / cold-start ──────────────────────────────────────────────────
  describe('empty / cold-start', () => {
    it('returns useRuby: true when no episodes exist (give Ruby a chance)', () => {
      const decision = assessCompetence([], 'Fix the auth bug', config);
      assertValidDecision(decision);
      expect(decision.useRuby).toBe(true);
      // 0 attempts < 3 minAttempts → "giving Ruby a chance to learn"
      expect(decision.reason).toMatch(/0 prior attempt|giving Ruby/i);
    });

    it('returns useRuby: true when episodes array is empty but task matches nothing', () => {
      const decision = assessCompetence([], 'Add rate limiting middleware', config);
      assertValidDecision(decision);
      expect(decision.useRuby).toBe(true);
    });
  });

  // ── Below minimum attempts ─────────────────────────────────────────────
  describe('below minimum attempts', () => {
    it('returns useRuby: true when attemptCount < minAttempts (1 attempt)', () => {
      // One matching episode with same exact task → attemptCount = 1
      const episodes = [
        makeEpisode({ task: 'Fix the auth bug in core/auth.ts', rubyAttempted: true, rubySucceeded: true }),
      ];
      const decision = assessCompetence(episodes, 'Fix the auth bug in core/auth.ts', config);
      assertValidDecision(decision);
      expect(decision.useRuby).toBe(true);
      expect(decision.reason).toContain('1 prior attempt');
      // confidence = 0.3 + 1/3*0.3 = 0.3 + 0.1 = 0.4
      expect(decision.confidence).toBeCloseTo(0.4, 5);
    });

    it('returns useRuby: true when attemptCount < minAttempts (2 attempts)', () => {
      const episodes = Array.from({ length: 2 }, () =>
        makeEpisode({ task: 'Add tests', rubyAttempted: true, rubySucceeded: false }),
      );
      const decision = assessCompetence(episodes, 'Add tests', config);
      assertValidDecision(decision);
      expect(decision.useRuby).toBe(true);
      expect(decision.reason).toContain('2 prior attempt');
      // confidence = 0.3 + 2/3*0.3 = 0.3 + 0.2 = 0.5
      expect(decision.confidence).toBeCloseTo(0.5, 5);
    });

    it('does NOT count episodes where rubyAttempted is false', () => {
      const episodes = [
        makeEpisode({ task: 'Fix auth', rubyAttempted: false }),
        makeEpisode({ task: 'Fix auth', rubyAttempted: false }),
      ];
      const decision = assessCompetence(episodes, 'Fix auth', config);
      assertValidDecision(decision);
      expect(decision.useRuby).toBe(true);
      // 0 attempts counted
      expect(decision.reason).toMatch(/0 prior attempt/);
    });
  });

  // ── At or above threshold ──────────────────────────────────────────────
  describe('at or above threshold', () => {
    it('returns useRuby: true when successRate >= threshold (0.7)', () => {
      // 10 attempts, 7 successes → 0.7 exactly at threshold
      const episodes = Array.from({ length: 10 }, (_, i) =>
        makeEpisode({
          task: 'Refactor the database layer',
          rubyAttempted: true,
          rubySucceeded: i < 7,
        }),
      );
      const decision = assessCompetence(episodes, 'Refactor the database layer', config);
      assertValidDecision(decision);
      expect(decision.useRuby).toBe(true);
      expect(decision.reason).toContain('70%');
      expect(decision.reason).toContain('meets threshold');
    });

    it('returns useRuby: true when successRate > threshold (all successes)', () => {
      const episodes = Array.from({ length: 5 }, () =>
        makeEpisode({
          task: 'Write unit tests for utils',
          rubyAttempted: true,
          rubySucceeded: true,
        }),
      );
      const decision = assessCompetence(episodes, 'Write unit tests for utils', config);
      assertValidDecision(decision);
      expect(decision.useRuby).toBe(true);
      expect(decision.reason).toContain('100%');
    });

    it('includes competenceLevel with correct attemptCount', () => {
      const episodes = Array.from({ length: 5 }, () =>
        makeEpisode({ task: 'Task X', rubyAttempted: true, rubySucceeded: true }),
      );
      const decision = assessCompetence(episodes, 'Task X', config);
      expect(decision.competenceLevel).toBeDefined();
      expect(decision.competenceLevel!.attemptCount).toBe(5);
      expect(decision.competenceLevel!.successRate).toBe(1);
    });
  });

  // ── Below threshold ────────────────────────────────────────────────────
  describe('below threshold', () => {
    it('returns useRuby: false when successRate < threshold', () => {
      // 10 attempts, 6 successes → 0.6 < 0.7
      const episodes = Array.from({ length: 10 }, (_, i) =>
        makeEpisode({
          task: 'Implement OAuth2 flow',
          rubyAttempted: true,
          rubySucceeded: i < 6,
        }),
      );
      const decision = assessCompetence(episodes, 'Implement OAuth2 flow', config);
      assertValidDecision(decision);
      expect(decision.useRuby).toBe(false);
      expect(decision.reason).toContain('below threshold');
      expect(decision.reason).toContain('60%');
    });

    it('returns useRuby: false when all attempts failed', () => {
      const episodes = Array.from({ length: 5 }, () =>
        makeEpisode({
          task: 'Complex refactor',
          rubyAttempted: true,
          rubySucceeded: false,
        }),
      );
      const decision = assessCompetence(episodes, 'Complex refactor', config);
      assertValidDecision(decision);
      expect(decision.useRuby).toBe(false);
      expect(decision.reason).toContain('0%');
    });

    it('escalates only after minAttempts threshold is met', () => {
      // 3 attempts, 0 success → attemptCount (3) >= minAttempts (3), successRate 0 < 0.7
      const episodes = Array.from({ length: 3 }, () =>
        makeEpisode({ task: 'Tricky bug', rubyAttempted: true, rubySucceeded: false }),
      );
      const decision = assessCompetence(episodes, 'Tricky bug', config);
      assertValidDecision(decision);
      expect(decision.useRuby).toBe(false);
    });

    it('still escalates with 2 successes out of 3 (0.67 < 0.7)', () => {
      const episodes = [
        makeEpisode({ task: 'Edge case task', rubyAttempted: true, rubySucceeded: true }),
        makeEpisode({ task: 'Edge case task', rubyAttempted: true, rubySucceeded: true }),
        makeEpisode({ task: 'Edge case task', rubyAttempted: true, rubySucceeded: false }),
      ];
      const decision = assessCompetence(episodes, 'Edge case task', config);
      assertValidDecision(decision);
      expect(decision.useRuby).toBe(false);
      // 2/3 ≈ 0.667 < 0.7
    });
  });

  // ── Shape guarantees ───────────────────────────────────────────────────
  describe('shape guarantees', () => {
    it('always returns non-empty reason', () => {
      // Empty episodes
      const d1 = assessCompetence([], 'task', config);
      expect(d1.reason.length).toBeGreaterThan(0);

      // With episodes
      const episodes = [makeEpisode({ task: 'task', rubyAttempted: true, rubySucceeded: true })];
      const d2 = assessCompetence(episodes, 'task', config);
      expect(d2.reason.length).toBeGreaterThan(0);
    });

    it('always returns fallbackModel', () => {
      const d1 = assessCompetence([], 'task', config);
      expect(d1.fallbackModel).toBe(DEFAULT_FALLBACK_MODEL);

      const episodes = [makeEpisode({ task: 'task', rubyAttempted: true, rubySucceeded: false })];
      const d2 = assessCompetence(episodes, 'task', config);
      expect(d2.fallbackModel).toBe(DEFAULT_FALLBACK_MODEL);
    });

    it('confidence is always between 0 and 1', () => {
      const cases: Array<[Episode[], string, string]> = [
        [[], 'task', 'empty'],
        [[makeEpisode({ task: 't', rubyAttempted: true, rubySucceeded: true })], 't', '1 attempt'],
        [Array.from({ length: 10 }, () => makeEpisode({ task: 't', rubyAttempted: true, rubySucceeded: true })), 't', '10 successes'],
        [Array.from({ length: 10 }, () => makeEpisode({ task: 't', rubyAttempted: true, rubySucceeded: false })), 't', '10 failures'],
      ];

      for (const [eps, task, label] of cases) {
        const d = assessCompetence(eps, task, config);
        expect(d.confidence).toBeGreaterThanOrEqual(0);
        expect(d.confidence).toBeLessThanOrEqual(1);
        expect(Number.isNaN(d.confidence)).toBe(false);
      }
    });

    it('never throws on empty episodes array', () => {
      expect(() => assessCompetence([], 'task', config)).not.toThrow();
      expect(() => assessCompetence([], '', config)).not.toThrow();
    });

    it('never throws on invalid input (null, undefined, non-array)', () => {
      expect(() => assessCompetence(null as unknown as Episode[], 'task', config)).not.toThrow();
      expect(() => assessCompetence(undefined as unknown as Episode[], 'task', config)).not.toThrow();
      expect(() => assessCompetence('not-an-array' as unknown as Episode[], 'task', config)).not.toThrow();
    });

    it('never throws on null/undefined task', () => {
      expect(() => assessCompetence([], null as unknown as string, config)).not.toThrow();
      expect(() => assessCompetence([], undefined as unknown as string, config)).not.toThrow();
    });
  });

  // ── Disabled config ────────────────────────────────────────────────────
  describe('disabled config', () => {
    it('returns useRuby: false when config.enabled is false', () => {
      const disabledConfig: RubyConfig = { ...DEFAULT_RUBY_CONFIG, enabled: false };
      const decision = assessCompetence([], 'Any task', disabledConfig);
      assertValidDecision(decision);
      expect(decision.useRuby).toBe(false);
      expect(decision.reason).toMatch(/disabled/i);
      expect(decision.confidence).toBe(1);
    });

    it('returns useRuby: false even with high success rate when disabled', () => {
      const episodes = Array.from({ length: 10 }, () =>
        makeEpisode({ task: 'Task', rubyAttempted: true, rubySucceeded: true }),
      );
      const disabledConfig: RubyConfig = { ...DEFAULT_RUBY_CONFIG, enabled: false };
      const decision = assessCompetence(episodes, 'Task', disabledConfig);
      expect(decision.useRuby).toBe(false);
    });
  });

  // ── Task similarity ────────────────────────────────────────────────────
  describe('task similarity matching', () => {
    it('matches exact same task string', () => {
      const episodes = [
        makeEpisode({ task: 'Exact same task string', rubyAttempted: true, rubySucceeded: true }),
        makeEpisode({ task: 'Exact same task string', rubyAttempted: true, rubySucceeded: true }),
        makeEpisode({ task: 'Exact same task string', rubyAttempted: true, rubySucceeded: true }),
      ];
      const decision = assessCompetence(episodes, 'Exact same task string', config);
      expect(decision.competenceLevel!.attemptCount).toBe(3);
    });

    it('matches tasks where one is substring of the other', () => {
      const episodes = [
        makeEpisode({ task: 'Fix the authentication bug in the login module', rubyAttempted: true, rubySucceeded: true }),
        makeEpisode({ task: 'Fix the authentication bug in the login module', rubyAttempted: true, rubySucceeded: true }),
        makeEpisode({ task: 'Fix the authentication bug in the login module', rubyAttempted: true, rubySucceeded: true }),
      ];
      const decision = assessCompetence(episodes, 'Fix the authentication bug', config);
      // Substring match → all 3 match
      expect(decision.competenceLevel!.attemptCount).toBe(3);
    });

    it('does NOT match completely different tasks', () => {
      const episodes = [
        makeEpisode({ task: 'Fix the authentication bug', rubyAttempted: true, rubySucceeded: true }),
        makeEpisode({ task: 'Fix the authentication bug', rubyAttempted: true, rubySucceeded: true }),
        makeEpisode({ task: 'Fix the authentication bug', rubyAttempted: true, rubySucceeded: true }),
      ];
      const decision = assessCompetence(episodes, 'Deploy to production server with Kubernetes Helm charts', config);
      // Completely different → 0 matches → attemptCount = 0 → useRuby: true (below minAttempts)
      expect(decision.useRuby).toBe(true);
      expect(decision.competenceLevel!.attemptCount).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateCompetence
// ─────────────────────────────────────────────────────────────────────────────
describe('updateCompetence', () => {
  it('adds new competence entry for unknown pattern', () => {
    const episode = makeEpisode({
      task: 'Add login functionality',
      taskCategory: 'implementation',
      rubyAttempted: true,
      rubySucceeded: true,
    });
    const result = updateCompetence([], episode);

    expect(result).toHaveLength(1);
    expect(result[0].attemptCount).toBe(1);
    expect(result[0].successRate).toBe(1);
    expect(result[0].examples).toHaveLength(1);
    expect(result[0].examples[0].succeeded).toBe(true);
    expect(result[0].taskPattern).toMatch(/^implementation:/);
  });

  it('updates existing entry on new episode (same task pattern)', () => {
    const episode1 = makeEpisode({
      task: 'Add login functionality',
      taskCategory: 'implementation',
      rubyAttempted: true,
      rubySucceeded: true,
    });
    const after1 = updateCompetence([], episode1);
    expect(after1).toHaveLength(1);
    expect(after1[0].attemptCount).toBe(1);
    expect(after1[0].successRate).toBe(1);

    // Second episode — same task, Ruby failed
    const episode2 = makeEpisode({
      task: 'Add login functionality',
      taskCategory: 'implementation',
      rubyAttempted: true,
      rubySucceeded: false,
    });
    const after2 = updateCompetence(after1, episode2);

    expect(after2).toHaveLength(1); // still one entry, updated
    expect(after2[0].attemptCount).toBe(2);
    expect(after2[0].successRate).toBe(0.5);
    expect(after2[0].examples).toHaveLength(2);
  });

  it('increments attemptCount correctly across multiple calls', () => {
    let levels: CompetenceLevel[] = [];
    for (let i = 0; i < 5; i++) {
      const ep = makeEpisode({
        task: 'Recurring task',
        taskCategory: 'review',
        rubyAttempted: true,
        rubySucceeded: i % 2 === 0, // alternate success/failure
      });
      levels = updateCompetence(levels, ep);
    }

    expect(levels).toHaveLength(1);
    expect(levels[0].attemptCount).toBe(5);
    // Successes at indices 0, 2, 4 → 3/5 = 0.6
    expect(levels[0].successRate).toBeCloseTo(0.6, 5);
  });

  it('recalculates successRate correctly — all successes', () => {
    let levels: CompetenceLevel[] = [];
    for (let i = 0; i < 4; i++) {
      const ep = makeEpisode({
        task: 'Always works',
        taskCategory: 'implementation',
        rubyAttempted: true,
        rubySucceeded: true,
      });
      levels = updateCompetence(levels, ep);
    }
    expect(levels[0].successRate).toBe(1);
    expect(levels[0].attemptCount).toBe(4);
  });

  it('recalculates successRate correctly — all failures', () => {
    let levels: CompetenceLevel[] = [];
    for (let i = 0; i < 3; i++) {
      const ep = makeEpisode({
        task: 'Always fails',
        taskCategory: 'refactor',
        rubyAttempted: true,
        rubySucceeded: false,
      });
      levels = updateCompetence(levels, ep);
    }
    expect(levels[0].successRate).toBe(0);
    expect(levels[0].attemptCount).toBe(3);
  });

  it('ignores episodes where rubyAttempted is false', () => {
    const episode = makeEpisode({
      task: 'Some task',
      rubyAttempted: false,
      rubySucceeded: false,
    });
    const result = updateCompetence([], episode);
    // rubyAttempted is false → ignored entirely
    expect(result).toHaveLength(0);
  });

  it('different task patterns create separate entries', () => {
    const ep1 = makeEpisode({
      task: 'Fix the authentication bug',
      taskCategory: 'implementation',
      rubyAttempted: true,
      rubySucceeded: true,
    });
    const ep2 = makeEpisode({
      task: 'Review the codebase for security issues',
      taskCategory: 'review',
      rubyAttempted: true,
      rubySucceeded: false,
    });

    const levels = updateCompetence(updateCompetence([], ep1), ep2);
    expect(levels).toHaveLength(2); // two distinct patterns
    expect(levels[0].taskPattern).not.toBe(levels[1].taskPattern);
  });

  it('never throws on invalid input (null, undefined, corrupt episode)', () => {
    expect(() => updateCompetence(null as unknown as CompetenceLevel[], null as unknown as Episode)).not.toThrow();
    expect(() => updateCompetence(undefined as unknown as CompetenceLevel[], undefined as unknown as Episode)).not.toThrow();
    expect(() => updateCompetence([], { notAnEpisode: true } as unknown as Episode)).not.toThrow();
  });

  it('limits examples to MAX_EXAMPLES (10)', () => {
    let levels: CompetenceLevel[] = [];
    for (let i = 0; i < 15; i++) {
      const ep = makeEpisode({
        task: 'Recurring pattern',
        taskCategory: 'implementation',
        rubyAttempted: true,
        rubySucceeded: i % 2 === 0,
      });
      levels = updateCompetence(levels, ep);
    }
    expect(levels[0].attemptCount).toBe(15);
    expect(levels[0].examples.length).toBeLessThanOrEqual(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getCompetenceReport
// ─────────────────────────────────────────────────────────────────────────────
describe('getCompetenceReport', () => {
  it('returns empty array for no episodes', () => {
    const report = getCompetenceReport([]);
    expect(report).toEqual([]);
  });

  it('returns empty array for episodes where none were rubyAttempted', () => {
    const episodes = [
      makeEpisode({ rubyAttempted: false, taskCategory: 'implementation' }),
      makeEpisode({ rubyAttempted: false, taskCategory: 'review' }),
    ];
    const report = getCompetenceReport(episodes);
    expect(report).toEqual([]);
  });

  it('groups by taskCategory correctly', () => {
    const episodes = [
      makeEpisode({ taskCategory: 'implementation', rubyAttempted: true, rubySucceeded: true }),
      makeEpisode({ taskCategory: 'implementation', rubyAttempted: true, rubySucceeded: false }),
      makeEpisode({ taskCategory: 'research', rubyAttempted: true, rubySucceeded: true }),
      makeEpisode({ taskCategory: 'research', rubyAttempted: true, rubySucceeded: true }),
    ];
    const report = getCompetenceReport(episodes);

    // implementation: 1 success / 2 = 0.5
    const imp = report.find(r => r.category === 'implementation');
    expect(imp).toBeDefined();
    expect(imp!.successRate).toBe(0.5);
    expect(imp!.count).toBe(2);

    // research: 2 / 2 = 1.0
    const res = report.find(r => r.category === 'research');
    expect(res).toBeDefined();
    expect(res!.successRate).toBe(1);
    expect(res!.count).toBe(2);
  });

  it('calculates successRate per category correctly', () => {
    const episodes = [
      makeEpisode({ taskCategory: 'refactor', rubyAttempted: true, rubySucceeded: false }),
      makeEpisode({ taskCategory: 'refactor', rubyAttempted: true, rubySucceeded: false }),
      makeEpisode({ taskCategory: 'refactor', rubyAttempted: true, rubySucceeded: true }),
    ];
    const report = getCompetenceReport(episodes);

    expect(report).toHaveLength(1);
    expect(report[0].category).toBe('refactor');
    expect(report[0].successRate).toBeCloseTo(1 / 3, 5);
    expect(report[0].count).toBe(3);
  });

  it('sorts categories by count descending', () => {
    const episodes = [
      makeEpisode({ taskCategory: 'review', rubyAttempted: true, rubySucceeded: true }),
      makeEpisode({ taskCategory: 'review', rubyAttempted: true, rubySucceeded: false }),
      makeEpisode({ taskCategory: 'implementation', rubyAttempted: true, rubySucceeded: true }),
      makeEpisode({ taskCategory: 'implementation', rubyAttempted: true, rubySucceeded: true }),
      makeEpisode({ taskCategory: 'implementation', rubyAttempted: true, rubySucceeded: false }),
      makeEpisode({ taskCategory: 'research', rubyAttempted: true, rubySucceeded: true }),
    ];
    const report = getCompetenceReport(episodes);

    expect(report[0].category).toBe('implementation'); // count 3, first
    expect(report[1].category).toBe('review');          // count 2
    expect(report[2].category).toBe('research');        // count 1
  });

  it('never throws on invalid input', () => {
    expect(() => getCompetenceReport(null as unknown as Episode[])).not.toThrow();
    expect(() => getCompetenceReport(undefined as unknown as Episode[])).not.toThrow();
    expect(() => getCompetenceReport([{ invalid: 'episode' } as unknown as Episode])).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldFineTune
// ─────────────────────────────────────────────────────────────────────────────
describe('shouldFineTune', () => {
  it('returns false when failures < minFailures (default 20)', () => {
    const episodes = Array.from({ length: 19 }, () =>
      makeEpisode({ rubyAttempted: true, rubySucceeded: false }),
    );
    expect(shouldFineTune(episodes)).toBe(false);
  });

  it('returns true when failures >= minFailures (default 20)', () => {
    const episodes = Array.from({ length: 20 }, () =>
      makeEpisode({ rubyAttempted: true, rubySucceeded: false }),
    );
    expect(shouldFineTune(episodes)).toBe(true);
  });

  it('returns true when failures > minFailures', () => {
    const episodes = Array.from({ length: 50 }, () =>
      makeEpisode({ rubyAttempted: true, rubySucceeded: false }),
    );
    expect(shouldFineTune(episodes)).toBe(true);
  });

  it('counts only rubyAttempted + not rubySucceeded episodes', () => {
    // Mix: 20 failures (counted), plus successes (not counted), plus not-attempted (not counted)
    const failures = Array.from({ length: 20 }, () =>
      makeEpisode({ rubyAttempted: true, rubySucceeded: false }),
    );
    const successes = Array.from({ length: 5 }, () =>
      makeEpisode({ rubyAttempted: true, rubySucceeded: true }),
    );
    const notAttempted = Array.from({ length: 10 }, () =>
      makeEpisode({ rubyAttempted: false }),
    );
    const episodes = [...failures, ...successes, ...notAttempted];
    expect(shouldFineTune(episodes)).toBe(true);
  });

  it('does not count episodes where rubySucceeded is true', () => {
    // 19 failures + many successes → still under threshold
    const failures = Array.from({ length: 19 }, () =>
      makeEpisode({ rubyAttempted: true, rubySucceeded: false }),
    );
    const successes = Array.from({ length: 100 }, () =>
      makeEpisode({ rubyAttempted: true, rubySucceeded: true }),
    );
    expect(shouldFineTune([...failures, ...successes])).toBe(false);
  });

  it('respects custom minFailures threshold', () => {
    const episodes = Array.from({ length: 5 }, () =>
      makeEpisode({ rubyAttempted: true, rubySucceeded: false }),
    );
    expect(shouldFineTune(episodes, 5)).toBe(true);
    expect(shouldFineTune(episodes, 6)).toBe(false);
    expect(shouldFineTune(episodes, 10)).toBe(false);
  });

  it('minimum threshold is 1 (never lower)', () => {
    const episodes = makeEpisode({ rubyAttempted: true, rubySucceeded: false });
    // Even with minFailures = 0, it should be clamped to 1
    expect(shouldFineTune([episodes], 0)).toBe(true);
    expect(shouldFineTune([], 0)).toBe(false);
  });

  it('never throws on invalid input', () => {
    expect(() => shouldFineTune(null as unknown as Episode[])).not.toThrow();
    expect(() => shouldFineTune(undefined as unknown as Episode[])).not.toThrow();
    expect(() => shouldFineTune([], undefined as unknown as number)).not.toThrow();
  });

  it('uses DEFAULT_MIN_FAILURES constant', () => {
    expect(DEFAULT_MIN_FAILURES).toBe(20);
  });
});
