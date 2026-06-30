import { describe, it, expect } from 'vitest';
import type {
  RubyProjectContext,
  RubyDiamondEnvelope,
} from '../../src/orchestration/ruby-types.js';

describe('RubyProjectContext', () => {
  it('accepts a complete context with all optional fields', () => {
    const ctx: RubyProjectContext = {
      projectRoot: '/tmp/myapp',
      framework: 'rails',
      hasGemfile: true,
      hasGemfileLock: true,
      rubyVersion: '3.3.0',
      testFramework: 'rspec',
      entrypoints: ['config.ru', 'bin/rails'],
      capturedAt: Date.now(),
    };
    expect(ctx.framework).toBe('rails');
    expect(ctx.entrypoints).toHaveLength(2);
  });

  it('allows unknown framework and test runner for non-Ruby trees', () => {
    const ctx: RubyProjectContext = {
      projectRoot: '/tmp/ts-only',
      framework: 'unknown',
      hasGemfile: false,
      hasGemfileLock: false,
      testFramework: 'unknown',
      entrypoints: [],
      capturedAt: 1,
    };
    expect(ctx.rubyVersion).toBeUndefined();
    expect(ctx.entrypoints).toEqual([]);
  });
});

describe('RubyDiamondEnvelope', () => {
  it('wraps typed payloads with version and surface metadata', () => {
    const envelope: RubyDiamondEnvelope<{ planId: string }> = {
      version: 1,
      surface: 'aura-code',
      kind: 'plan_created',
      timestamp: 1000,
      payload: { planId: 'p-1' },
    };
    expect(envelope.version).toBe(1);
    expect(envelope.surface).toBe('aura-code');
    expect(envelope.payload.planId).toBe('p-1');
  });
});