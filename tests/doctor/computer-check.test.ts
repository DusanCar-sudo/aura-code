import { describe, it, expect } from 'vitest';
import { checkComputerUse, checkComputerUseMacOS } from '../../src/doctor/checks.js';

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

  it('stops early and says so on a platform with no port at all', () => {
    // No point probing evdev on Windows; the honest answer is "not supported yet".
    const f = checkComputerUse(process.cwd(), 'win32');
    expect(f.some(x => x.name === 'platform' && /Linux only/i.test(x.message))).toBe(true);
    expect(f.some(x => x.name === 'python evdev')).toBe(false);
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

/**
 * macOS has no computer-use backend yet. These pin the shape of the readiness
 * report that has to come back from a real Mac before one gets written —
 * because the failures that matter there are silent, exactly as they were on
 * Linux, and cannot be reasoned about from another platform.
 */
describe('the macOS readiness preflight', () => {
  const findings = () => checkComputerUseMacOS();

  it('says macOS is unimplemented before it says anything else', () => {
    // The report must never read as "your Mac is ready" for a feature that
    // does not exist. Whatever the probes find, this is the first line.
    const first = findings()[0];
    expect(first.name).toBe('platform');
    expect(first.message).toMatch(/not implemented on macOS/i);
    expect(first.severity).toBe('warn');
  });

  it('is reachable through the platform dispatch, not only directly', () => {
    const f = checkComputerUse(process.cwd(), 'darwin');
    expect(f.some(x => x.name === 'platform' && /not implemented on macOS/i.test(x.message))).toBe(true);
    // ...and it must not fall through to the Linux probes.
    expect(f.some(x => x.name === '/dev/uinput')).toBe(false);
  });

  it('checks both TCC permissions — the two that fail without erroring', () => {
    const names = findings().map(f => f.name);
    // Screen Recording denied returns the wallpaper with windows omitted;
    // Accessibility denied accepts events and drops them. Neither raises.
    expect(names).toContain('Screen Recording permission');
    expect(names).toContain('Accessibility permission');
  });

  it('explains that the grant attaches to the terminal, not to Aura', () => {
    // The most common way to get this wrong is to look for "aura" in the
    // Privacy settings list, where it will never appear.
    const scope = findings().find(f => f.name === 'permission scope');
    expect(scope?.message).toMatch(/Terminal|iTerm/);
  });

  it('names what is silently lost, not just what is missing', () => {
    const perms = findings().filter(f =>
      f.name.endsWith('permission') && f.severity === 'warn');
    for (const f of perms) {
      expect(f.message, `no failure mode described: ${f.name}`)
        .toMatch(/silently|no error|discarded|missing/i);
    }
  });

  it('reports only ok or warn, like the Linux path', () => {
    expect(findings().every(f => f.severity === 'ok' || f.severity === 'warn')).toBe(true);
    expect(findings().every(f => f.category === 'computer')).toBe(true);
  });
});
