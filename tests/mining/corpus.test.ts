import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { trainingDataStats } from '../../src/mining/corpus.js';

function makeRow(provenance: string): string {
  return JSON.stringify({
    instruction: 'task',
    input: 'ctx',
    output: 'answer',
    metadata: { projectRoot: '/fake', taskCategory: 'implementation', provenance, timestamp: 1 },
  });
}

describe('trainingDataStats — :mine --stats', () => {
  it('counts rows by provenance across jsonl files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-corpus-'));
    const dir = path.join(root, 'training-data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-01-01.jsonl'), makeRow('mined') + '\n' + makeRow('correction') + '\n');
    fs.writeFileSync(path.join(dir, '2026-01-02.jsonl'), makeRow('correction') + '\n');

    const stats = trainingDataStats(root);
    expect(stats.total).toBe(3);
    expect(stats.byProvenance).toEqual({ mined: 1, correction: 2 });
    expect(stats.files).toBe(2);
    expect(stats.filePaths.length).toBe(2);
  });

  it('returns empty corpus when training-data/ does not exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-corpus-'));
    const stats = trainingDataStats(root);
    expect(stats.total).toBe(0);
    expect(stats.byProvenance).toEqual({});
    expect(stats.files).toBe(0);
  });

  it('counts rows with missing provenance as unknown', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-corpus-'));
    const dir = path.join(root, 'training-data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.jsonl'), makeRow('mined') + '\n' + '{"metadata":{}}\n');
    const stats = trainingDataStats(root);
    expect(stats.total).toBe(2);
    expect(stats.byProvenance).toEqual({ mined: 1, unknown: 1 });
  });

  it('skips malformed rows without throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-corpus-'));
    const dir = path.join(root, 'training-data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.jsonl'), 'not json\n' + makeRow('mined') + '\n');
    const stats = trainingDataStats(root);
    expect(stats.total).toBe(1);
    expect(stats.byProvenance).toEqual({ mined: 1 });
  });
});
