import { describe, it, expect } from 'vitest';
import { PROVIDER_REGISTRY } from '../../src/setup/provider-registry.js';
import { PROVIDER_LIST } from '../../src/providers/live-models.js';
import { applyRoutePrefix } from '../../src/cli/model-select.js';
import { apiKeyEnvVarForModel, createProvider } from '../../src/providers/factory.js';

// ─────────────────────────────────────────────────────────────────────────────
// The invariant: picking a model from a provider must call THAT provider.
//
// It was broken and nobody noticed. BytePlus and FPT resell other vendors'
// models under their own gateway, so their catalogue ids are bare vendor names
// ("deepseek-v4-flash-ga-260813", "DeepSeek-V4-Flash"). Neither had an entry in
// ROUTE_PREFIX, so choosing BytePlus's DeepSeek model produced a bare
// `deepseek-*` id — which routes to DeepSeek's own API, with a DeepSeek key.
// Wrong endpoint, wrong bill, and an error that blames the wrong provider.
//
// The consistency test in registry-consistency.test.ts checks that the five
// routing structures agree with each other. This one checks something else:
// that the user-facing catalogue agrees with routing at all.
// ─────────────────────────────────────────────────────────────────────────────

/** Registry entries are keyed by display name; the picker keys by id. */
const PICKER_ID = new Map(PROVIDER_LIST.map(e => [e.name, e.id]));

function pickerIdFor(displayName: string): string {
  return PICKER_ID.get(displayName) ?? displayName.toLowerCase().split(' ')[0];
}

describe('catalogue → routing', () => {
  it('every listed model resolves to its own provider’s API key', () => {
    const violations: string[] = [];
    for (const entry of PROVIDER_REGISTRY) {
      if (!entry.envKey) continue;             // local backends need no key
      const pid = pickerIdFor(entry.name);
      for (const model of entry.models) {
        const routed = applyRoutePrefix(pid, model.id);
        const resolved = apiKeyEnvVarForModel(routed);
        if (resolved && resolved !== entry.envKey) {
          violations.push(
            `${entry.name}: "${model.id}" → "${routed}" resolves ${resolved}, expected ${entry.envKey}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('a reseller’s bare vendor id is prefixed rather than left to collide', () => {
    // The exact shape of the bug, pinned so it cannot come back.
    expect(applyRoutePrefix('byteplus', 'deepseek-v4-flash-ga-260813'))
      .toBe('byteplus/deepseek-v4-flash-ga-260813');
    expect(applyRoutePrefix('fpt', 'DeepSeek-V4-Flash')).toBe('fpt/DeepSeek-V4-Flash');
    expect(apiKeyEnvVarForModel('byteplus/deepseek-v4-flash-ga-260813')).toBe('ARK_API_KEY');
    expect(apiKeyEnvVarForModel('fpt/DeepSeek-V4-Flash')).toBe('FPT_API_KEY');
  });

  it('leaves an id that already carries a routing prefix alone', () => {
    expect(applyRoutePrefix('byteplus', 'deepseek/deepseek-v4-pro'))
      .toBe('deepseek/deepseek-v4-pro');
    expect(applyRoutePrefix('deepseek', 'deepseek/deepseek-v4-pro'))
      .toBe('deepseek/deepseek-v4-pro');
  });

  it('every listed model constructs a provider without throwing', () => {
    const origVertexProj = process.env.VERTEX_PROJECT_ID;
    process.env.VERTEX_PROJECT_ID = 'test-vertex-project';
    const failures: string[] = [];
    for (const entry of PROVIDER_REGISTRY) {
      const pid = pickerIdFor(entry.name);
      for (const model of entry.models) {
        try {
          createProvider({ model: applyRoutePrefix(pid, model.id), apiKey: 'test-key' });
        } catch (e) {
          failures.push(`${entry.name} / ${model.id}: ${String(e).slice(0, 80)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    if (origVertexProj === undefined) delete process.env.VERTEX_PROJECT_ID;
    else process.env.VERTEX_PROJECT_ID = origVertexProj;
  });
});
