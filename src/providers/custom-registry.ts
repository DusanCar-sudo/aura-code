/**
 * The custom-provider registry: providers declared in .aura.json (or
 * registered programmatically) that createProvider() checks before its
 * built-in routing.
 *
 * This is one mutable module-level array with a setter and a getter, and it
 * lives on its own because three unrelated things need to read it — provider
 * construction and key lookup in factory.ts, and the model catalog in
 * known-models.ts. Holding it in factory.ts forced the catalog to import the
 * factory, which is the cycle this module exists to break: nothing here
 * imports anything but a type, so both sides can depend on it freely.
 *
 * factory.ts re-exports both functions, so existing callers are unaffected.
 */

import type { ProviderDef } from '../config/project-config.js';

let customProviders: ProviderDef[] = [];

/**
 * Register custom providers from .aura.json or any other source.
 * These are checked before built-in routing in createProvider().
 */
export function registerCustomProviders(providers: ProviderDef[]): void {
  customProviders = providers;
}

/** Get currently registered custom providers. */
export function getCustomProviders(): ProviderDef[] {
  return customProviders;
}
