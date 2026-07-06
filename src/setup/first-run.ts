/**
 * First-run detection — decides whether the setup wizard should fire.
 *
 * The wizard itself is runProviderWizard (provider-wizard.ts); this module
 * only answers "is Aura configured yet?". Provider metadata comes from the
 * canonical PROVIDER_REGISTRY — no duplicate provider/model tables here.
 */
import { PROVIDER_REGISTRY } from './provider-registry.js';
import { getApiKey } from '../util/env.js';
import { loadGlobalConfig } from './global-config.js';
import { loadProviderConfig } from './provider-wizard.js';

/** True iff the user has a saved global config (their default provider). */
export function hasGlobalConfig(): boolean {
  return loadGlobalConfig() !== null;
}

/** True iff the user has set at least one known provider env var (any case). */
export function hasAnyEnvKey(): boolean {
  for (const p of PROVIDER_REGISTRY) {
    if (p.envKey && getApiKey(p.envKey)) return true;
  }
  return false;
}

/**
 * Pure detection: would we need the wizard?
 *
 * The wizard fires when the user has no MODEL picked. An API key in env
 * does NOT count as "configured" — the user still needs to choose a model.
 * The wizard will detect the env key and pre-select that provider.
 */
export function needsWizard(opts: { cliApiKey?: string; cliModel?: string } = {}): boolean {
  if (opts.cliApiKey) return false;
  if (opts.cliModel) return false;
  if (hasGlobalConfig()) return false;      // has a model saved already
  if (loadProviderConfig() !== null) return false;  // wizard save (covers keyless providers like Ollama)
  return true;
}

/** Kept for backward compatibility (some callers still use it). */
export function hasAnyProvider(): boolean {
  return hasGlobalConfig() || hasAnyEnvKey();
}
