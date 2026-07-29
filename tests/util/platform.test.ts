import { describe, it, expect, afterEach, vi } from 'vitest';
import { isNativeWindows, isWSL, platformWarning } from '../../src/util/platform.js';

// Windows is no longer WSL-only: the shell guardrails now screen cmd.exe and
// PowerShell too (config/defaults.ts). The notice that remains is about
// coverage, not safety, and these tests pin both the detection and the fact
// that it no longer overstates the risk.

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

const REAL_PLATFORM = process.platform;

afterEach(() => {
  setPlatform(REAL_PLATFORM);
  delete process.env.WSL_DISTRO_NAME;
  delete process.env.WSL_INTEROP;
  vi.restoreAllMocks();
});

describe('platform detection', () => {
  it('flags native Windows', () => {
    setPlatform('win32');
    expect(isNativeWindows()).toBe(true);
    expect(isWSL()).toBe(false);
  });

  it('does not flag Linux or macOS', () => {
    setPlatform('linux');
    expect(isNativeWindows()).toBe(false);
    setPlatform('darwin');
    expect(isNativeWindows()).toBe(false);
  });

  it('detects WSL from the environment marker', () => {
    setPlatform('linux');
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    expect(isWSL()).toBe(true);
  });

  it('does not report WSL on plain Linux', () => {
    setPlatform('linux');
    // No WSL_* vars, and this host's /proc/version has no microsoft marker.
    expect(isWSL()).toBe(false);
  });

  it('never reports WSL on a non-linux platform', () => {
    setPlatform('darwin');
    process.env.WSL_DISTRO_NAME = 'Ubuntu'; // stray var must not fool it
    expect(isWSL()).toBe(false);
  });
});

describe('platformWarning', () => {
  it('notes newer Windows support and still offers WSL as the fallback', () => {
    setPlatform('win32');
    const w = platformWarning();
    expect(w).toBeTruthy();
    expect(w).toMatch(/wsl --install/);
    // It must say what is actually covered rather than just "be careful".
    expect(w).toMatch(/Remove-Item/);
  });

  it('no longer claims Windows is unsupported', () => {
    setPlatform('win32');
    const w = platformWarning()!;
    // The guardrails cover cmd and PowerShell now; leaving the old wording in
    // place would push users to WSL for a hazard that has been fixed.
    expect(w).not.toMatch(/not supported/i);
    expect(w).not.toMatch(/POSIX-only/i);
  });

  it('is silent on supported platforms', () => {
    setPlatform('linux');
    expect(platformWarning()).toBeNull();
    setPlatform('darwin');
    expect(platformWarning()).toBeNull();
  });
});
