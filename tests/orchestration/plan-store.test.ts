import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planStore } from '../../src/orchestration/plan-store.js';
import type { ExecutionPlan, OrchestrationMemory } from '../../src/orchestration/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────
function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    id: 'plan-test-1',
    goal: 'Implement feature X',
    steps: [
      {
        id: 's1',
        specialist: 'researcher',
        task: 'Gather context',
        context: '',
        dependsOn: [],
        status: 'waiting',
      },
    ],
    status: 'pending',
    created: Date.now(),
    ...overrides,
  };
}

function makeMemory(overrides: Partial<OrchestrationMemory> = {}): OrchestrationMemory {
  return {
    key: 'auth_strategy',
    value: 'jwt',
    stepId: 's1',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// planStore — plans (isolated via mocked plansDir → temp directory)
// ─────────────────────────────────────────────────────────────────────────────
describe('planStore — plans', () => {
  let homeTmp: string;
  let plansDir: string;

  beforeEach(() => {
    homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-plans-'));
    vi.stubEnv('HOME', homeTmp);
    plansDir = planStore.plansDir();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(homeTmp, { recursive: true, force: true });
  });

  it('save() writes valid JSON to correct path', async () => {
    const plan = makePlan({ id: 'save-path-test' });
    await planStore.save(plan);

    const filePath = path.join(plansDir, 'save-path-test.json');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(filePath + '.tmp')).toBe(false);

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ExecutionPlan;
    expect(parsed.id).toBe('save-path-test');
    expect(parsed.goal).toBe(plan.goal);
    expect(parsed.steps).toHaveLength(1);
  });

  it('load() returns null when plan does not exist', async () => {
    const loaded = await planStore.load('does-not-exist');
    expect(loaded).toBeNull();
  });

  it('load() returns correct plan after save()', async () => {
    const plan = makePlan({
      id: 'roundtrip',
      goal: 'Round-trip goal',
      status: 'running',
      steps: [
        {
          id: 's1',
          specialist: 'coder',
          task: 'Write code',
          context: 'Use TypeScript',
          dependsOn: [],
          status: 'running',
          tokensUsed: 42,
        },
      ],
    });
    await planStore.save(plan);

    const loaded = await planStore.load('roundtrip');
    expect(loaded).toEqual(plan);
  });

  it('list() returns empty array when no plans exist', async () => {
    const plans = await planStore.list();
    expect(plans).toEqual([]);
  });

  it('list() returns all saved plans', async () => {
    const older = makePlan({ id: 'plan-old', created: 1_000 });
    const newer = makePlan({ id: 'plan-new', created: 9_000 });
    await planStore.save(older);
    await planStore.save(newer);

    const plans = await planStore.list();
    expect(plans).toHaveLength(2);
    expect(plans.map(p => p.id).sort()).toEqual(['plan-new', 'plan-old']);
    // Most recently created first
    expect(plans[0].id).toBe('plan-new');
    expect(plans[1].id).toBe('plan-old');
  });

  it('delete() removes the plan file', async () => {
    const plan = makePlan({ id: 'to-delete' });
    await planStore.save(plan);
    const filePath = path.join(plansDir, 'to-delete.json');
    expect(fs.existsSync(filePath)).toBe(true);

    await planStore.delete('to-delete');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('delete() is safe when file does not exist', async () => {
    await expect(planStore.delete('missing-plan')).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// planStore — per-project memory (real fs under mkdtemp project root)
// ─────────────────────────────────────────────────────────────────────────────
describe('planStore — memory', () => {
  let projectTmp: string;

  beforeEach(() => {
    projectTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-proj-'));
  });

  afterEach(() => {
    fs.rmSync(projectTmp, { recursive: true, force: true });
  });

  it('saveMemory() creates the file if it does not exist', async () => {
    const entry = makeMemory({ key: 'first_key', value: 'alpha' });
    await planStore.saveMemory(projectTmp, entry);

    const memPath = planStore.memoryPath(projectTmp);
    expect(fs.existsSync(memPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(memPath, 'utf8')) as OrchestrationMemory[];
    expect(raw).toHaveLength(1);
    expect(raw[0].key).toBe('first_key');
  });

  it('saveMemory() appends to existing memory', async () => {
    await planStore.saveMemory(projectTmp, makeMemory({ key: 'k1', value: 'v1', timestamp: 100 }));
    await planStore.saveMemory(projectTmp, makeMemory({ key: 'k2', value: 'v2', timestamp: 200 }));

    const all = await planStore.listMemory(projectTmp);
    expect(all).toHaveLength(2);
    expect(all.map(e => e.key).sort()).toEqual(['k1', 'k2']);
  });

  it('getMemory() returns null for unknown key', async () => {
    const result = await planStore.getMemory(projectTmp, 'unknown');
    expect(result).toBeNull();
  });

  it('getMemory() returns correct entry after save', async () => {
    const entry = makeMemory({ key: 'strategy', value: 'oauth2', timestamp: 500 });
    await planStore.saveMemory(projectTmp, entry);

    const got = await planStore.getMemory(projectTmp, 'strategy');
    expect(got).toEqual(entry);
  });

  it('getMemory() returns the latest entry when the same key is written twice', async () => {
    await planStore.saveMemory(
      projectTmp,
      makeMemory({ key: 'dup', value: 'old', timestamp: 100 }),
    );
    await planStore.saveMemory(
      projectTmp,
      makeMemory({ key: 'dup', value: 'new', timestamp: 200 }),
    );

    const got = await planStore.getMemory(projectTmp, 'dup');
    expect(got!.value).toBe('new');
    expect(got!.timestamp).toBe(200);
  });

  it('listMemory() returns all entries', async () => {
    await planStore.saveMemory(projectTmp, makeMemory({ key: 'a', timestamp: 300 }));
    await planStore.saveMemory(projectTmp, makeMemory({ key: 'b', timestamp: 100 }));
    await planStore.saveMemory(projectTmp, makeMemory({ key: 'c', timestamp: 200 }));

    const all = await planStore.listMemory(projectTmp);
    expect(all).toHaveLength(3);
    expect(all.map(e => e.key)).toEqual(['a', 'c', 'b']); // newest-first
  });

  it('listMemory() handles corrupt JSON gracefully — returns empty, never throws', async () => {
    const memPath = planStore.memoryPath(projectTmp);
    fs.mkdirSync(path.dirname(memPath), { recursive: true });
    fs.writeFileSync(memPath, '{not valid json!!!');

    await expect(planStore.listMemory(projectTmp)).resolves.toEqual([]);
    await expect(planStore.getMemory(projectTmp, 'any')).resolves.toBeNull();
  });

  it('getMemory() handles corrupt JSON gracefully — returns null, never throws', async () => {
    const memPath = planStore.memoryPath(projectTmp);
    fs.mkdirSync(path.dirname(memPath), { recursive: true });
    fs.writeFileSync(memPath, '[]'); // valid but empty
    fs.writeFileSync(memPath, 'not-json-at-all');

    await expect(planStore.getMemory(projectTmp, 'k')).resolves.toBeNull();
  });
});