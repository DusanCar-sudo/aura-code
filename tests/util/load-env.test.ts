import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadEnvFile } from '../../src/util/load-env.js';

describe('loadEnvFile', () => {
  let tmpDir: string;
  let envPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-env-'));
    envPath = path.join(tmpDir, '.env');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads unset vars without overriding existing', () => {
    fs.writeFileSync(envPath, 'FOO=from_file\nBAR=baz\n');
    process.env.FOO = 'already';
    loadEnvFile(envPath);
    expect(process.env.FOO).toBe('already');
    expect(process.env.BAR).toBe('baz');
    delete process.env.BAR;
  });
});