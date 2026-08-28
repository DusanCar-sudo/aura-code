import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../../src/setup/provider-test.js';

/**
 * Failure classification.
 *
 * The bug this pins: every non-2xx answer surfaced as one generic "Connection
 * failed", whose only offered remedy was "re-enter your API key". A valid
 * OpenAI key on an unpaid account (429 quota), a valid OpenCode Go key on an
 * empty balance (401 "Insufficient balance"), and a retired Zen model (500)
 * all looked identical to a wrong key — so re-typing the key forever was the
 * only path the wizard offered, and none of them can be fixed that way.
 *
 * The verbatim messages below are what those three providers actually returned.
 */
describe('classifyFailure', () => {
  it('reads OpenAI 429 quota as billing, not a bad key', () => {
    expect(classifyFailure(429, 'You exceeded your current quota, please check your plan and billing details.'))
      .toBe('billing');
  });

  it('reads OpenCode 401 "Insufficient balance" as billing — the key authenticated', () => {
    // A 401 is the one status where message beats status: OpenCode Zen answers
    // an empty balance with 401, so status alone would send the user back to
    // re-typing a key that already works.
    expect(classifyFailure(401, 'Insufficient balance. Manage your billing here: https://opencode.ai/workspace/…/billing'))
      .toBe('billing');
  });

  it('still reads a plain 401 as an auth failure', () => {
    expect(classifyFailure(401, 'Incorrect API key provided')).toBe('auth');
    expect(classifyFailure(403, 'Forbidden')).toBe('auth');
  });

  it('reads a bare 429 with no billing wording as a rate limit', () => {
    expect(classifyFailure(429, 'Rate limit reached for requests')).toBe('rate');
  });

  it('reads a dead gateway model as a model problem', () => {
    expect(classifyFailure(404, 'The model `gpt-5-nano` does not exist')).toBe('model');
    expect(classifyFailure(400, 'Upstream request failed: Model is unavailable.')).toBe('model');
  });

  it('reads a 5xx as the provider\'s problem, not the user\'s', () => {
    expect(classifyFailure(500, 'Internal server error')).toBe('server');
    expect(classifyFailure(503, 'Endpoint is unavailable.')).toBe('server');
  });

  it('does not mistake an unrelated 400 for a model problem', () => {
    expect(classifyFailure(400, 'Invalid request body')).toBe('auth');
  });
});

/**
 * Prefix stripping. `go-anthropic/` was routable in the factory but unknown to
 * the tester, so the wizard sent "go-anthropic/claude-sonnet-5" to the gateway
 * verbatim and every OpenCode Go setup failed its own connection test.
 */
describe('model id sent to the wire', () => {
  it('strips go-anthropic/ like the factory does', async () => {
    const { stripRoutingPrefix } = await import('../../src/providers/factory.js');
    expect(stripRoutingPrefix('go-anthropic/claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(stripRoutingPrefix('opencode/big-pickle')).toBe('big-pickle');
    expect(stripRoutingPrefix('byteplus/deepseek-v4-flash-ga-260731')).toBe('deepseek-v4-flash-ga-260731');
  });
});
