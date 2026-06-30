import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  defaultCompetenceMatrix,
  recommendSpecialist,
  applyOutcome,
  competenceStore,
  PRIMARY_DOMAIN,
} from '../../src/orchestration/competence.js';

describe('competence — scoring', () => {
  it('defaultCompetenceMatrix() assigns higher priors on primary domains', () => {
    const scores = defaultCompetenceMatrix();
    const coderImpl = scores.find(s => s.specialist === 'coder' && s.domain === 'implementation');
    const coderReview = scores.find(s => s.specialist === 'coder' && s.domain === 'review');
    expect(coderImpl!.score).toBeGreaterThan(coderReview?.score ?? 0);
  });

  it('recommendSpecialist() picks the highest score for a domain', () => {
    const scores = defaultCompetenceMatrix();
    expect(recommendSpecialist('review', scores)).toBe('reviewer');
    expect(recommendSpecialist('planning', scores)).toBe('planner');
    expect(recommendSpecialist('implementation', scores)).toBe('coder');
  });

  it('applyOutcome() increases score on success', () => {
    const before = defaultCompetenceMatrix();
    const after = applyOutcome(before, {
      specialist: 'coder',
      domain: 'implementation',
      success: true,
      quality: 1,
    });
    const prev = before.find(s => s.specialist === 'coder' && s.domain === 'implementation')!;
    const next = after.find(s => s.specialist === 'coder' && s.domain === 'implementation')!;
    expect(next.score).toBeGreaterThan(prev.score);
    expect(next.sampleCount).toBe(1);
  });

  it('applyOutcome() decreases score on failure', () => {
    const before = defaultCompetenceMatrix();
    const after = applyOutcome(before, {
      specialist: 'researcher',
      domain: 'research',
      success: false,
    });
    const prev = before.find(s => s.specialist === 'researcher' && s.domain === 'research')!;
    const next = after.find(s => s.specialist === 'researcher' && s.domain === 'research')!;
    expect(next.score).toBeLessThan(prev.score);
  });

  it('PRIMARY_DOMAIN maps each specialist to its main domain', () => {
    expect(PRIMARY_DOMAIN.researcher).toBe('research');
    expect(PRIMARY_DOMAIN.coder).toBe('implementation');
    expect(PRIMARY_DOMAIN.reviewer).toBe('review');
    expect(PRIMARY_DOMAIN.planner).toBe('planning');
  });
});

describe('competenceStore', () => {
  let projectTmp: string;

  beforeEach(() => {
    projectTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-comp-'));
  });

  afterEach(() => {
    fs.rmSync(projectTmp, { recursive: true, force: true });
  });

  it('load() returns defaults when file is missing', async () => {
    const profile = await competenceStore.load(projectTmp);
    expect(profile.projectRoot).toBe(projectTmp);
    expect(profile.version).toBe(1);
    expect(profile.scores.length).toBeGreaterThan(0);
  });

  it('save() and load() round-trip', async () => {
    const profile = await competenceStore.load(projectTmp);
    profile.scores[0].score = 0.42;
    await competenceStore.save(profile);

    const loaded = await competenceStore.load(projectTmp);
    expect(loaded.scores[0].score).toBe(0.42);
    expect(fs.existsSync(competenceStore.filePath(projectTmp))).toBe(true);
  });

  it('recordOutcome() persists updated scores', async () => {
    const updated = await competenceStore.recordOutcome(projectTmp, {
      specialist: 'coder',
      domain: 'ruby_gems',
      success: true,
      quality: 0.9,
    });
    const entry = updated.scores.find(s => s.specialist === 'coder' && s.domain === 'ruby_gems');
    expect(entry!.sampleCount).toBeGreaterThanOrEqual(1);

    const reloaded = await competenceStore.load(projectTmp);
    const again = reloaded.scores.find(s => s.specialist === 'coder' && s.domain === 'ruby_gems');
    expect(again!.sampleCount).toBe(entry!.sampleCount);
  });

  it('load() handles corrupt JSON gracefully — returns defaults, never throws', async () => {
    const filePath = competenceStore.filePath(projectTmp);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{broken');

    await expect(competenceStore.load(projectTmp)).resolves.toMatchObject({
      projectRoot: projectTmp,
      version: 1,
    });
  });
});