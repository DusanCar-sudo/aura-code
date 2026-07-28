import { describe, it, expect, afterEach, vi } from 'vitest';
import { isNativeWindows, isWSL, platformWarning } from '../../src/util/platform.js';

// Windows support is deliberately WSL-only: the shell guardrails
// (SAFE_SHELL_COMMANDS, DANGEROUS_PATTERNS) are POSIX strings, so a native
// Windows run auto-approves nothing and its denylist misses the destructive
// cmd/PowerShell commands. These tests pin the detection that warns about it.

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
  it('warns on native Windows and points at WSL', () => {
    setPlatform('win32');
    const w = platformWarning();
    expect(w).toBeTruthy();
    expect(w).toMatch(/not supported/i);
    expect(w).toMatch(/wsl --install/);
    // It must name the specific gap, not just say "unsupported".
    expect(w).toMatch(/Remove-Item/);
  });

  it('is silent on supported platforms', () => {
    setPlatform('linux');
    expect(platformWarning()).toBeNull();
    setPlatform('darwin');
    expect(platformWarning()).toBeNull();
  });
});
