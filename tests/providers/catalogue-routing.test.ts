import { describe, it, expect } from 'vitest';
import { routeCatalogueId } from '../../src/providers/provider-descriptors.js';
import { apiKeyEnvVarForModel } from '../../src/providers/factory.js';
import { PROVIDER_REGISTRY } from '../../src/setup/provider-registry.js';

/**
 * Picking a provider must reach that provider.
 *
 * Resellers make this non-obvious. BytePlus and FPT serve other vendors'
 * models through their own gateway, so their catalogue entries are bare vendor
 * names — FPT lists plain "GLM-5.2". Sent unprefixed it routes to Zhipu's own
 * API with a Zhipu key: the wrong endpoint, the wrong bill, and an
 * "insufficient balance" error naming an account the user never chose.
 *
 * That is not hypothetical. The web client's provider picker sent catalogue
 * ids verbatim, so choosing "FPT Cloud AI · GLM-5.2" silently billed Zhipu and
 * failed with a balance error the user could not explain.
 */

describe('a reseller catalogue id', () => {
  it('routes to the reseller, not the original vendor', () => {
    expect(routeCatalogueId('FPT Cloud AI', 'GLM-5.2')).toBe('fpt/GLM-5.2');
    expect(apiKeyEnvVarForModel(routeCatalogueId('FPT Cloud AI', 'GLM-5.2'))).toBe('FPT_API_KEY');
  });

  it('sends the same model id to different accounts per reseller', () => {
    // DeepSeek-V4-Flash is listed by two gateways. Which one is billed depends
    // entirely on the prefix, so this is the case that has to be right.
    const viaFpt = routeCatalogueId('FPT Cloud AI', 'DeepSeek-V4-Flash');
    const viaArk = routeCatalogueId('BytePlus ModelArk', 'DeepSeek-V4-Flash');
    expect(viaFpt).not.toBe(viaArk);
    expect(apiKeyEnvVarForModel(viaFpt)).toBe('FPT_API_KEY');
    expect(apiKeyEnvVarForModel(viaArk)).toBe('ARK_API_KEY');
  });

  it('is idempotent — its own prefix is not doubled', () => {
    expect(routeCatalogueId('FPT Cloud AI', 'fpt/GLM-5.2')).toBe('fpt/GLM-5.2');
  });

  it('prefixes a Hugging Face org/model id rather than reading it as routing', () => {
    // HF ids are `org/model` and several orgs collide with routing prefixes.
    // Treating "Qwen/..." as already-routed sent it to Alibaba's DashScope key.
    const routed = routeCatalogueId('Hugging Face', 'Qwen/Qwen2.5-Coder-32B-Instruct');
    expect(routed).toBe('huggingface/Qwen/Qwen2.5-Coder-32B-Instruct');
    expect(apiKeyEnvVarForModel(routed)).toBe('HUGGINGFACE_API_KEY');
  });

  it('leaves a provider that needs no prefix alone', () => {
    expect(routeCatalogueId('Anthropic (Claude)', 'claude-opus-4-5-20251001'))
      .toBe('claude-opus-4-5-20251001');
  });

  it('is a no-op for a display name nothing matches', () => {
    expect(routeCatalogueId('Nothing Like This', 'some-model')).toBe('some-model');
  });
});

describe('every model the settings panel offers', () => {
  it('resolves to its own provider key, never another vendor', () => {
    // The invariant the picker depends on, checked across the whole registry
    // rather than the two resellers we happened to think of.
    const wrong: string[] = [];
    for (const entry of PROVIDER_REGISTRY) {
      if (!entry.envKey) continue;
      for (const model of entry.models) {
        const routed = routeCatalogueId(entry.name, model.id);
        const key = apiKeyEnvVarForModel(routed);
        if (key && key !== entry.envKey) wrong.push(`${entry.name}/${model.id} -> ${key} (want ${entry.envKey})`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
