import { describe, it, expect } from 'vitest';
import { checkComputerUse } from '../../src/doctor/checks.js';

/**
 * The value of this check is that it fires *before* a run, not during one.
 * Without it the first symptom of a missing dependency is a task dying
 * mid-flight with a Python traceback — after the model has already spent turns
 * planning around a tool that could never have worked.
 */

const findings = () => checkComputerUse(process.cwd());

describe('the computer-use preflight', () => {
  it('reports under its own category so it can be shown as a section', () => {
    expect(findings().every(f => f.category === 'computer')).toBe(true);
  });

  it('never reports error — the feature is opt-in', () => {
    // A machine that will never enable computer use is not broken for lacking
    // evdev, and an error here would make `aura doctor` red for everyone.
    expect(findings().every(f => f.severity === 'ok' || f.severity === 'warn')).toBe(true);
  });

  it('always checks that the sidecar shipped', () => {
    // tsc does not copy .py files, so this is the check that catches a build
    // whose asset step did not run — invisible in a source checkout.
    expect(findings().some(f => f.name === 'sidecar')).toBe(true);
  });

  it('names what to install rather than the symptom', () => {
    // "No module named evdev" is not something a user can act on.
    for (const f of findings()) {
      if (f.severity !== 'warn') continue;
      expect(
        /install|run npm run build|add your user|Set AURA_PYTHON|only|expected/i.test(f.message),
        `unactionable warning: ${f.message}`,
      ).toBe(true);
    }
  });

  it('stops early and says so on a non-Linux platform', () => {
    // No point probing evdev on macOS; the honest answer is "not supported yet".
    if (process.platform === 'linux') return;
    const f = findings();
    expect(f.some(x => x.name === 'platform' && /Linux only/i.test(x.message))).toBe(true);
    expect(f.some(x => x.name === 'python3')).toBe(false);
  });

  it('covers every runtime dependency the sidecar imports or spawns', () => {
    if (process.platform !== 'linux') return;
    const names = findings().map(f => f.name);
    for (const need of ['python3', 'python gi/GLib', 'python evdev', 'pipewiresrc',
                        'ImageMagick', '/dev/uinput', 'session']) {
      expect(names, `missing preflight for ${need}`).toContain(need);
    }
  });
});
