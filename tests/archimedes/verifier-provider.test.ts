import { describe, it, expect } from 'vitest';
import { resolveVerifierProvider } from '../../src/archimedes/alternator.js';
import { DEFAULT_ARCHIMEDES_CONFIG } from '../../src/archimedes/types.js';
import type { LLMProvider } from '../../src/providers/types.js';
import { loadProjectConfig } from '../../src/config/project-config.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Who grades the answer.
//
// On the escalation and council paths the verifier used to receive the very
// provider instance that produced the answer — the large model marking its own
// homework. A model asked whether its own output is valid is a weak detector of
// its own fabrications, so the missed-escalation rate measured that way carries
// an unknown self-grading bias.
//
// verifierModel makes the grader independent. The default is unchanged, so
// nothing moves for existing configs.
// ─────────────────────────────────────────────────────────────────────────────

function fakeLarge(model = 'claude-sonnet-5'): LLMProvider {
  return { name: 'Large', model } as unknown as LLMProvider;
}

describe('resolveVerifierProvider', () => {
  it('defaults to the large model, preserving the existing behaviour', () => {
    const large = fakeLarge();
    const { provider, error } = resolveVerifierProvider(DEFAULT_ARCHIMEDES_CONFIG, large);
    expect(provider).toBe(large);
    expect(error).toBeUndefined();
  });

  it('builds an independent provider when verifierModel names another model', () => {
    const large = fakeLarge('claude-sonnet-5');
    const { provider, error } = resolveVerifierProvider(
      { ...DEFAULT_ARCHIMEDES_CONFIG, verifierModel: 'deepseek/deepseek-v4-pro' },
      large,
    );
    expect(error).toBeUndefined();
    expect(provider).not.toBe(large);
    expect(provider.model).toBe('deepseek-v4-pro');
  });

  it('reuses the large model when verifierModel names it — no second client', () => {
    const large = fakeLarge('claude-sonnet-5');
    const { provider } = resolveVerifierProvider(
      { ...DEFAULT_ARCHIMEDES_CONFIG, verifierModel: 'claude-sonnet-5' },
      large,
    );
    expect(provider).toBe(large);
  });

  it('falls back with a reason rather than failing the run on a bad verifier', () => {
    const large = fakeLarge();
    const { provider, error } = resolveVerifierProvider(
      // No routing prefix, no base URL, no OPENAI_API_KEY path — createProvider throws.
      { ...DEFAULT_ARCHIMEDES_CONFIG, verifierModel: 'not-a-real-model:tag' },
      large,
    );
    // Either it resolved to something or it fell back — never threw.
    if (error !== undefined) expect(provider).toBe(large);
    expect(() => provider.model).not.toThrow();
  });
});

describe('.aura.json archimedes.verifierModel', () => {
  /** Writes a throwaway project with the given archimedes block and loads it. */
  function withConfig(archimedes: unknown): ReturnType<typeof loadProjectConfig> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-verifier-'));
    try {
      fs.writeFileSync(path.join(dir, '.aura.json'), JSON.stringify({ archimedes }));
      return loadProjectConfig(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('is read from project config', () => {
    const cfg = withConfig({ verifierModel: 'deepseek/deepseek-v4-pro' });
    expect(cfg.archimedes?.verifierModel).toBe('deepseek/deepseek-v4-pro');
  });

  it('ignores a blank value rather than configuring an unusable verifier', () => {
    const cfg = withConfig({ verifierModel: '   ' });
    expect(cfg.archimedes?.verifierModel).toBeUndefined();
  });
});
