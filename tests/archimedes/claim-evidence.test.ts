import { describe, it, expect } from 'vitest';
import {
  extractClaimTerms,
  claimAwareExcerpt,
  PER_RESULT_BUDGET,
} from '../../src/archimedes/claim-evidence.js';

describe('extractClaimTerms', () => {
  it('pulls file paths, line refs and symbols out of an answer', () => {
    const terms = extractClaimTerms(
      'The retry lives in `src/util/retry.ts:42`, in withBackoff, gated by MAX_RETRIES.',
    );
    expect(terms).toContain('src/util/retry.ts:42');
    expect(terms).toContain('withBackoff');
    expect(terms).toContain('MAX_RETRIES');
  });

  it('drops prose words that could not contradict anything', () => {
    const terms = extractClaimTerms('The function returns a string value if the file exists.');
    for (const noise of ['the', 'function', 'returns', 'string', 'value', 'file']) {
      expect(terms).not.toContain(noise);
    }
  });

  it('ranks the specific above the generic, so budget pressure drops vaguest first', () => {
    const terms = extractClaimTerms('`exactSpan` appears in src/a/b.ts near parseConfig.');
    expect(terms.indexOf('exactSpan')).toBeLessThan(terms.indexOf('parseConfig'));
  });

  it('returns nothing for an answer that makes no checkable claim', () => {
    expect(extractClaimTerms('It looks fine to me.')).toEqual([]);
  });
});

describe('claimAwareExcerpt', () => {
  /** A file long enough that a 300-char head misses everything that matters. */
  const bigFile = [
    '/* Copyright 2019. All rights reserved. Licensed under MIT. */'.padEnd(400, ' '),
    'x'.repeat(3_000),
    'export function withBackoff(n: number) { return n * MAX_RETRIES; }',
    'y'.repeat(3_000),
  ].join(' ');

  it('keeps the span that mentions the claim, which a head truncation misses', () => {
    const excerpt = claimAwareExcerpt(bigFile, ['withBackoff', 'MAX_RETRIES']);
    expect(excerpt).toContain('withBackoff');
    expect(excerpt).toContain('MAX_RETRIES');
    // The old behaviour — first 300 chars — contained neither.
    expect(bigFile.slice(0, 300)).not.toContain('withBackoff');
  });

  it('respects the per-result budget', () => {
    const excerpt = claimAwareExcerpt(bigFile, ['withBackoff'], 300);
    expect(excerpt.length).toBeLessThanOrEqual(320); // budget + ellipsis marks
  });

  it('returns content untouched when it already fits', () => {
    expect(claimAwareExcerpt('short and complete', ['anything'])).toBe('short and complete');
  });

  it('falls back to a head when the result corroborates nothing', () => {
    const noise = 'z'.repeat(5_000);
    const excerpt = claimAwareExcerpt(noise, ['withBackoff']);
    expect(excerpt.startsWith('z')).toBe(true);
    expect(excerpt.length).toBeLessThan(PER_RESULT_BUDGET);
  });

  it('marks elision so the verifier knows it is seeing excerpts, not the whole', () => {
    const excerpt = claimAwareExcerpt(bigFile, ['withBackoff']);
    expect(excerpt).toContain('…');
  });

  it('cannot be monopolised by one ubiquitous term', () => {
    const repeated = ('needle ' + 'q'.repeat(200)).repeat(50);
    const excerpt = claimAwareExcerpt(repeated, ['needle'], 600);
    expect(excerpt.length).toBeLessThanOrEqual(640);
  });

  it('covers several distinct claims rather than exhausting the first', () => {
    const doc = [
      'a'.repeat(1_500), ' alpha_one ', 'b'.repeat(1_500),
      ' beta_two ', 'c'.repeat(1_500),
    ].join('');
    const excerpt = claimAwareExcerpt(doc, ['alpha_one', 'beta_two'], 600);
    expect(excerpt).toContain('alpha_one');
    expect(excerpt).toContain('beta_two');
  });
});
