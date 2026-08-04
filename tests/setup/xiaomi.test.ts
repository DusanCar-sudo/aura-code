import { describe, it, expect } from 'vitest';
import {
  defaultXiaomiBaseUrl,
  normalizeXiaomiWizardConfig,
  xiaomiKeyKind,
} from '../../src/setup/xiaomi.js';

describe('xiaomi wizard helpers', () => {
  it('detects token plan keys', () => {
    expect(xiaomiKeyKind('tp-abc')).toBe('token-plan');
    expect(xiaomiKeyKind('sk-abc')).toBe('paygo');
  });

  it('picks base URL from key prefix', () => {
    expect(defaultXiaomiBaseUrl('tp-x')).toContain('token-plan-sgp');
    expect(defaultXiaomiBaseUrl('sk-x')).toBe('https://api.xiaomimimo.com/v1');
  });

  it('remaps mimo-v2-flash to mimo-v2.5 on token plan', () => {
    const r = normalizeXiaomiWizardConfig(
      'mimo-v2-flash',
      'tp-test',
      'https://token-plan-sgp.xiaomimimo.com/v1',
    );
    expect(r.model).toBe('mimo-v2.5');
    expect(r.note).toMatch(/does not support/);
  });
});