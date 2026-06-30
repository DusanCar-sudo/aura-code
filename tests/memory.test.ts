import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { memoryTool, MEMORY_DEFINITION } from '../src/tools/memory.js';

const testDir = path.join(os.tmpdir(), 'ruby-test-memory-' + Date.now());
const memDir = path.join(testDir, '.aura', 'memory');

beforeEach(() => {
  process.env.HOME = testDir;
  fs.mkdirSync(memDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('MEMORY_DEFINITION', () => {
  it('has correct name', () => expect(MEMORY_DEFINITION.name).toBe('memory'));
  it('requires action', () => expect(MEMORY_DEFINITION.parameters.required).toEqual(['action']));
});

describe('memoryTool — remember/recall', () => {
  it('remembers and recalls a value', async () => {
    const r1 = await memoryTool({ action: 'remember', key: 'name', value: 'Dušan' });
    expect(r1).toContain('Remembered');

    const r2 = await memoryTool({ action: 'recall', key: 'name' });
    expect(r2).toContain('Dušan');
  });

  it('returns error for missing key on remember', async () => {
    const r = await memoryTool({ action: 'remember', value: 'test' });
    expect(r).toContain('Error: key');
  });

  it('returns error for missing value on remember', async () => {
    const r = await memoryTool({ action: 'remember', key: 'test' });
    expect(r).toContain('Error: value');
  });

  it('returns not found for unknown key', async () => {
    const r = await memoryTool({ action: 'recall', key: 'nonexistent' });
    expect(r).toContain('No memory found');
  });
});

describe('memoryTool — forget', () => {
  it('forgets a stored value', async () => {
    await memoryTool({ action: 'remember', key: 'temp', value: 'data' });
    const r = await memoryTool({ action: 'forget', key: 'temp' });
    expect(r).toContain('Forgot');

    const r2 = await memoryTool({ action: 'recall', key: 'temp' });
    expect(r2).toContain('No memory found');
  });
});

describe('memoryTool — list', () => {
  it('lists stored memories', async () => {
    await memoryTool({ action: 'remember', key: 'a', value: '1' });
    await memoryTool({ action: 'remember', key: 'b', value: '2' });
    const r = await memoryTool({ action: 'list' });
    expect(r).toContain('a');
    expect(r).toContain('b');
  });

  it('returns empty message when no memories', async () => {
    const r = await memoryTool({ action: 'list' });
    expect(r).toContain('No memories');
  });
});

describe('memoryTool — namespaces', () => {
  it('isolates memories by namespace', async () => {
    await memoryTool({ action: 'remember', key: 'x', value: 'ns1', namespace: 'work' });
    await memoryTool({ action: 'remember', key: 'x', value: 'ns2', namespace: 'personal' });

    const r1 = await memoryTool({ action: 'recall', key: 'x', namespace: 'work' });
    expect(r1).toContain('ns1');

    const r2 = await memoryTool({ action: 'recall', key: 'x', namespace: 'personal' });
    expect(r2).toContain('ns2');
  });
});
