import { describe, it, expect } from 'vitest';
import type { LLMProvider } from '../../src/providers/types.js';
import { parseVerifierReply, verifyArchimedesAnswer } from '../../src/archimedes/alternator.js';

function verifierReturning(complete: LLMProvider['complete']): LLMProvider {
  return { name: 'fake', model: 'fake-verifier', complete } as unknown as LLMProvider;
}

describe('parseVerifierReply — strict typed verdict', () => {
  it('accepts only an exact VALID line', () => {
    expect(parseVerifierReply('VALID')).toEqual({ verdict: 'accept', reason: '' });
    expect(parseVerifierReply('  valid.\n')).toEqual({ verdict: 'accept', reason: '' });
  });

  it('rejects INVALID with its reason', () => {
    expect(parseVerifierReply('INVALID: cites a missing file')).toEqual({ verdict: 'reject', reason: 'cites a missing file' });
    expect(parseVerifierReply('INVALID')).toEqual({ verdict: 'reject', reason: 'failed verification' });
  });

  it('never accepts a reply that merely starts with VALID', () => {
    expect(parseVerifierReply('VALIDATION FAILED: fabricated symbol').verdict).toBe('abstain');
    expect(parseVerifierReply('VALID\nbut actually the answer is wrong').verdict).toBe('abstain');
  });

  it('abstains on empty or unparseable replies', () => {
    expect(parseVerifierReply('').verdict).toBe('abstain');
    expect(parseVerifierReply('I think it looks fine').verdict).toBe('abstain');
  });
});

describe('verifyArchimedesAnswer — errors are not rejects', () => {
  it('returns unreachable with the error kept separately when the provider throws', async () => {
    const v = await verifyArchimedesAnswer('find foo', 'foo is in a.ts', [], verifierReturning(async () => {
      throw new Error('ECONNRESET');
    }));
    expect(v.verdict).toBe('unreachable');
    expect(v.reason).toBe('');
    expect(v.error).toContain('ECONNRESET');
  });

  it('returns accept with usage for a VALID reply', async () => {
    const v = await verifyArchimedesAnswer('find foo', 'foo is in a.ts', [], verifierReturning(async () => ({
      text: 'VALID', usage: { inputTokens: 7, outputTokens: 1 },
    }) as any));
    expect(v).toEqual({ verdict: 'accept', reason: '', usage: { inputTokens: 7, outputTokens: 1 } });
  });
});
