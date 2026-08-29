import { describe, it, expect } from 'vitest';
import { apiKeysAllowedFor } from '../../src/server/index.js';

/**
 * Setting a provider API key used to be gated behind --allow-plugin-install,
 * which bundled two very different risks: installing a plugin runs unsandboxed
 * code with full privileges, while setting a key writes one process.env entry
 * for a name the registry declares, never to disk and never readable back.
 *
 * The practical effect was that you could not type your API key into the
 * settings panel without also enabling arbitrary remote code execution — and
 * the refusal you got talked about plugins, so the reason was not even legible.
 * These pin the split.
 */

describe('who may set an API key', () => {
  it('allows it on a plain localhost bind — the common case', () => {
    // Reaching the port already means being the user who started the server.
    expect(apiKeysAllowedFor({})).toBe(true);
  });

  it('refuses once the server is on the network', () => {
    // There the pairing token is the only thing in front of a field that takes
    // a secret, which is fine for a local convenience and not for a standing one.
    expect(apiKeysAllowedFor({ lan: true })).toBe(false);
    expect(apiKeysAllowedFor({ tailscale: true })).toBe(false);
    expect(apiKeysAllowedFor({ lan: true, tailscale: true })).toBe(false);
  });

  it('lets an operator say yes anyway', () => {
    expect(apiKeysAllowedFor({ lan: true, allowApiKeys: true })).toBe(true);
    expect(apiKeysAllowedFor({ tailscale: true, allowApiKeys: true })).toBe(true);
  });

  it('lets an operator say no even on localhost', () => {
    // The explicit answer wins in both directions, including the paranoid one.
    expect(apiKeysAllowedFor({ allowApiKeys: false })).toBe(false);
  });
});
