import { describe, it, expect, afterEach } from 'vitest';

import {
  registerCustomProviders,
  getCustomProviders,
} from '../../src/providers/custom-registry.js';
import * as knownModels from '../../src/providers/known-models.js';
import { getAllModels } from '../../src/providers/known-models.js';
import * as factory from '../../src/providers/factory.js';

/**
 * The gap this closes: the custom-provider registry used to be module state
 * inside factory.ts, and the model catalog read that variable directly. Pulling
 * the catalog into known-models.ts meant the registry had to move too — and the
 * failure mode of getting that wrong is silent. If custom-registry.ts were ever
 * duplicated, re-declared, or imported under a second specifier, each consumer
 * would get its own array: .aura.json providers would register fine, factory
 * would route to them fine, and only the model picker would come up empty.
 *
 * So these assert the identity of the state across all three modules, not the
 * behaviour of any one of them. tests/factory.test.ts already covers what the
 * registry *does*; this covers that there is exactly one of it.
 */

const ACME = {
  name: 'Acme',
  prefixes: ['acme/'],
  baseUrl: 'https://acme.example/v1',
  apiKeyEnv: 'ACME_API_KEY',
  models: [{ id: 'acme/x1', name: 'Acme X1', speed: 'Fast' }],
};

describe('the custom-provider registry is a single shared array', () => {
  afterEach(() => { registerCustomProviders([]); });

  it('factory.ts re-exports the same registry, not a copy', () => {
    registerCustomProviders([ACME]);
    expect(factory.getCustomProviders().map(p => p.name)).toEqual(['Acme']);

    // …and in the other direction, since factory.ts is where nearly every
    // caller registers from today.
    registerCustomProviders([]);
    factory.registerCustomProviders([ACME]);
    expect(getCustomProviders().map(p => p.name)).toEqual(['Acme']);
  });

  it('known-models.getAllModels sees providers registered through factory.ts', () => {
    // This is the pairing that actually broke in the picker: registration goes
    // through factory, listing comes out of known-models.
    expect(getAllModels().some(m => m.id === 'acme/x1')).toBe(false);
    factory.registerCustomProviders([ACME]);
    const listed = getAllModels().find(m => m.id === 'acme/x1');
    expect(listed).toEqual({
      id: 'acme/x1', name: 'Acme X1', provider: 'Acme', speed: 'Fast',
    });
  });

  it('factory.getAllModels is the same function known-models exports', () => {
    expect(factory.getAllModels).toBe(getAllModels);
    expect(factory.KNOWN_MODELS).toBe(knownModels.KNOWN_MODELS);
  });

  it('unregistering removes the models again', () => {
    factory.registerCustomProviders([ACME]);
    expect(getAllModels().some(m => m.id === 'acme/x1')).toBe(true);
    factory.registerCustomProviders([]);
    expect(getAllModels().some(m => m.id === 'acme/x1')).toBe(false);
    expect(getCustomProviders()).toEqual([]);
  });
});
