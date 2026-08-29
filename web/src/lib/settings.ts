import { safeGet, safeSet, detectLocale, type Locale } from '../i18n';

/**
 * Client-side settings.
 *
 * Persisted per-browser, which is the honest scope: this is one operator's
 * preference on one device, not engine configuration. The two settings that
 * ARE engine configuration — permission level and sandbox — are sent to the
 * server on every session create, because a preference the engine never hears
 * is a lie told by a toggle.
 */

export type PermissionLevel = 'read-only' | 'normal' | 'auto';
export type Theme = 'dark' | 'light';

export interface Settings {
  locale: Locale;
  theme: Theme;
  /** Enforcement level the engine applies to tools. */
  permission: PermissionLevel;
  /**
   * Ask the engine for an out-of-process boundary rather than in-process
   * guards. Advisory from here: the engine refuses if no mechanism exists on
   * its platform, and the UI reflects what it answers rather than what was
   * asked (see docs/SANDBOX-DESIGN.md).
   */
  sandbox: boolean;
  /** Provider display name from the engine registry, e.g. "DeepSeek". */
  provider: string;
  model: string;
  maxTurns: number;
  maxInputTokens: number;
  /** Skill ids the operator has turned off. Absent = enabled. */
  disabledSkills: string[];
  /** Tool names the operator has turned off. Absent = enabled. */
  disabledTools: string[];
}

export const DEFAULTS: Settings = {
  locale: 'en',
  theme: 'dark',
  // Auto by default, matching PermissionSystem's own default and the way the
  // agent is actually used: a prompt on every write and every shell command is
  // one the operator answers "yes" to almost every time, and a confirmation
  // that is always approved teaches people to approve without reading — which
  // is worse than not asking. `auto` still refuses the known-dangerous command
  // list; it removes the routine prompt, not the guard. Both stricter levels
  // are one click away in Settings ▸ Permission.
  permission: 'auto',
  sandbox: false,
  provider: '',
  model: '',
  maxTurns: 30,
  maxInputTokens: 0,
  disabledSkills: [],
  disabledTools: [],
};

const KEY = 'aura.settings';

export function loadSettings(): Settings {
  const raw = safeGet(KEY);
  const base: Settings = { ...DEFAULTS, locale: detectLocale() };
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...base,
      ...parsed,
      // Never trust a persisted value into a union — a hand-edited or
      // stale key must not put the UI into a state the engine rejects.
      permission: isPermission(parsed.permission) ? parsed.permission : base.permission,
      theme: parsed.theme === 'light' ? 'light' : 'dark',
      disabledSkills: Array.isArray(parsed.disabledSkills) ? parsed.disabledSkills : [],
      disabledTools: Array.isArray(parsed.disabledTools) ? parsed.disabledTools : [],
    };
  } catch {
    return base;
  }
}

export function saveSettings(s: Settings): void {
  safeSet(KEY, JSON.stringify(s));
  safeSet('aura.locale', s.locale);
}

function isPermission(v: unknown): v is PermissionLevel {
  return v === 'read-only' || v === 'normal' || v === 'auto';
}
