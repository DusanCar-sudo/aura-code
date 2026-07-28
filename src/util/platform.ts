// ─────────────────────────────────────────────────────────────────────────────
// Platform support.
//
// Aura's shell guardrails are POSIX-only by construction:
//
//   SAFE_SHELL_COMMANDS  — ls, cat, grep, rg, … none of which match on cmd.exe,
//                          so in normal mode *every* command would stop for
//                          confirmation, including the read-only ones.
//   DANGEROUS_PATTERNS   — rm -rf, mkfs, dd if=, … and nothing for
//                          `del /s /q`, `rd /s`, `format`, or
//                          `Remove-Item -Recurse -Force`.
//
// runShell hands the string to execSync, which is /bin/sh on POSIX and
// cmd.exe on Windows. So a native Windows run is simultaneously more annoying
// (nothing is auto-approved) and less safe (the denylist misses the actual
// destructive commands). Neither is obvious from the outside — which is
// exactly why this warns loudly instead of letting someone find out later.
//
// WSL is a real Linux userland, so everything above holds there and Windows
// users get the supported behaviour by running inside it.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';

/** True when running as a native Windows process (not WSL, not Cygwin). */
export function isNativeWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * True when running inside the Windows Subsystem for Linux.
 *
 * process.platform is 'linux' under WSL, so this reads the kernel release,
 * which carries a "microsoft" marker under both WSL 1 and 2. WSL_DISTRO_NAME
 * is checked first because it is cheap and set by every modern WSL, but it is
 * not sufficient on its own — it does not survive `sudo` or some login shells.
 */
export function isWSL(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * A warning to show at startup on unsupported platforms, or null when the
 * platform is fine. Returns text rather than printing so the caller controls
 * formatting — the TUI, the plain CLI, and the doctor all render differently.
 */
export function platformWarning(): string | null {
  if (!isNativeWindows()) return null;
  return [
    'Running natively on Windows is not supported.',
    '',
    "  Aura's shell safety lists are POSIX-only, so on Windows:",
    '    · no command is auto-approved — every one stops for confirmation',
    '    · the dangerous-command denylist misses del /s /q, rd /s, format,',
    '      and Remove-Item -Recurse -Force',
    '',
    '  Run Aura inside WSL instead:',
    '',
    '      wsl --install          (once, in an admin PowerShell)',
    '      wsl                    (then install and run Aura in there)',
  ].join('\n');
}
