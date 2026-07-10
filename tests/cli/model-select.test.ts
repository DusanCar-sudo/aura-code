import { describe, it, expect } from 'vitest';
import {
  isProviderChange,
  apiKeyEnvForModelSwitch,
  buildModelRows,
  modelIdForNumber,
  modelCount,
} from '../../src/cli/model-select.js';

describe('isProviderChange', () => {
  it('detects a cross-provider switch', () => {
    expect(isProviderChange('glm-5.2', 'gpt-4o')).toBe(true);
    expect(isProviderChange('claude-sonnet-5', 'gemini-2.5-pro')).toBe(true);
  });

  it('same provider family is not a change', () => {
    expect(isProviderChange('gpt-4o', 'gpt-4o-mini')).toBe(false);
    expect(isProviderChange('glm-5.2', 'glm-5')).toBe(false);
  });

  it('missing previous model counts as a change (nothing safe to inherit)', () => {
    expect(isProviderChange(undefined, 'gpt-4o')).toBe(true);
  });
});

describe('apiKeyEnvForModelSwitch (Bug 2 regression)', () => {
  it('cross-provider switch resolves the NEW provider env, never the old one', () => {
    // Old provider Zhipu, switching to OpenAI: must persist OPENAI_API_KEY.
    expect(apiKeyEnvForModelSwitch('gpt-4o', 'glm-5.2', 'ZHIPU_API_KEY')).toBe('OPENAI_API_KEY');
    // Old provider Anthropic, switching to Zhipu: must persist ZHIPU_API_KEY.
    expect(apiKeyEnvForModelSwitch('glm-5', 'claude-sonnet-5', 'ANTHROPIC_API_KEY')).toBe('ZHIPU_API_KEY');
  });

  it('unknown new-provider env on a cross-provider switch falls back to AURA_API_KEY, not the old env', () => {
    // A model with no apiKeyEnv definition (e.g. ollama/local) must not
    // silently inherit the previous provider's env var name.
    const persisted = apiKeyEnvForModelSwitch('llama3', 'glm-5.2', 'ZHIPU_API_KEY');
    expect(persisted).not.toBe('ZHIPU_API_KEY');
    expect(persisted).toBe('AURA_API_KEY');
  });

  it('same-provider switch may keep the saved env name', () => {
    // Within one family the saved name is still valid; own definition wins
    // when present.
    expect(apiKeyEnvForModelSwitch('gpt-4o-mini', 'gpt-4o', 'OPENAI_API_KEY')).toBe('OPENAI_API_KEY');
  });
});

describe('buildModelRows (Bug 3 regression)', () => {
  const models = [
    { id: 'a-1', name: 'A One', provider: 'Alpha', speed: 'fast' },
    { id: 'a-2', name: 'A Two', provider: 'Alpha', speed: 'fast' },
    { id: 'b-1', name: 'B One', provider: 'Beta', speed: 'slow' },
    { id: 'c-1', name: 'C One', provider: 'Gamma', speed: 'slow' },
  ];

  it('headers carry no number; models are numbered contiguously from 1', () => {
    const rows = buildModelRows(models);
    const nums = rows.filter(r => r.kind === 'model').map(r => (r as { num: number }).num);
    expect(nums).toEqual([1, 2, 3, 4]); // no gaps despite 3 headers
  });

  it('first model is always 1 regardless of leading header', () => {
    const rows = buildModelRows(models);
    const first = rows.find(r => r.kind === 'model') as { num: number; id: string };
    expect(first.num).toBe(1);
    expect(first.id).toBe('a-1');
  });

  it('every number maps to a real selectable model, headers are unreachable', () => {
    const rows = buildModelRows(models);
    for (let n = 1; n <= modelCount(rows); n++) {
      expect(modelIdForNumber(rows, n)).toBeTruthy();
    }
    expect(modelIdForNumber(rows, 0)).toBeUndefined();
    expect(modelIdForNumber(rows, modelCount(rows) + 1)).toBeUndefined();
  });

  it('header count does not affect numbering', () => {
    const oneProvider = models.map(m => ({ ...m, provider: 'Solo' }));
    const rowsMany = buildModelRows(models);       // 3 headers
    const rowsOne = buildModelRows(oneProvider);   // 1 header
    const numsOf = (rows: ReturnType<typeof buildModelRows>) =>
      rows.filter(r => r.kind === 'model').map(r => (r as { num: number }).num);
    expect(numsOf(rowsMany)).toEqual(numsOf(rowsOne));
  });
});

describe('cross-provider key resolution (Bug 1 regression)', () => {
  it('clearing the stale key lets the factory resolve the NEW provider env key', async () => {
    const { getApiKeyForModel } = await import('../../src/providers/factory.js');
    const prevOpenAI = process.env.OPENAI_API_KEY;
    const prevZhipu = process.env.ZHIPU_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-new-provider-key';
    process.env.ZHIPU_API_KEY = 'sk-old-provider-key';
    try {
      // trySetModel clears runtimeConfig.apiKey on a provider change, so the
      // factory falls through to the model's own env chain — the NEW
      // provider's key, not the old one.
      expect(isProviderChange('glm-5.2', 'gpt-4o')).toBe(true);
      expect(getApiKeyForModel('gpt-4o')).toBe('sk-new-provider-key');
      expect(getApiKeyForModel('gpt-4o')).not.toBe('sk-old-provider-key');
    } finally {
      if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevOpenAI;
      if (prevZhipu === undefined) delete process.env.ZHIPU_API_KEY; else process.env.ZHIPU_API_KEY = prevZhipu;
    }
  });
});
