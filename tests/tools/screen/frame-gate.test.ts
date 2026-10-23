import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_DIR = path.resolve(here, '../../../src/tools/screen');

/** Runs FreshnessGate in a real python3 and returns the is_fresh() answers in order. */
function runGate(steps: string[]): boolean[] {
  const script = [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(SCREEN_DIR)})`,
    'from frame_gate import FreshnessGate',
    'g = FreshnessGate()',
    'out = []',
    ...steps.map((s) => (s === 'frame' ? 'g.note_frame()' : s === 'input' ? 'g.mark_input()' : `out.append(g.is_fresh())`)),
    'print(json.dumps(out))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-I', '-c', script]).toString());
}

describe('frame_gate.FreshnessGate', () => {
  it('reports fresh before any input has happened', () => {
    expect(runGate(['check'])).toEqual([true]);
  });

  it('reports stale right after an input until a new frame arrives', () => {
    expect(runGate(['frame', 'input', 'check', 'frame', 'check'])).toEqual([false, true]);
  });

  it('stays stale across a frame that arrived before the input', () => {
    expect(runGate(['input', 'frame', 'check'])).toEqual([true]);
  });
});
