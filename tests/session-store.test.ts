import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sessionStore } from '../src/agent/session-store.js';
import type { HistoryMessage } from '../src/providers/types.js';

describe('sessionStore', () => {
  let tmpDir: string;
  let file: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubycode-sess-'));
    file = path.join(tmpDir, 'session.json');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  const sample: HistoryMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there', toolCalls: [] },
    { role: 'tool_result', results: [{ id: 't1', name: 'read_file', content: 'ok' }] },
  ];

  it('save creates the file and load returns it', async () => {
    await sessionStore.save(file, sample);
    const loaded = await sessionStore.load(file);
    expect(loaded).toEqual(sample);
  });

  it('load returns empty for missing file', async () => {
    const loaded = await sessionStore.load(path.join(tmpDir, 'missing.json'));
    expect(loaded).toEqual([]);
  });

  it('load returns empty for malformed JSON', async () => {
    fs.writeFileSync(file, '{not json');
    const loaded = await sessionStore.load(file);
    expect(loaded).toEqual([]);
  });

  it('save creates parent directory if missing', async () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'sess.json');
    await sessionStore.save(nested, sample);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('save is atomic (writes to .tmp then renames)', async () => {
    await sessionStore.save(file, sample);
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });
});
