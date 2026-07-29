import { describe, it, expect } from 'vitest';
import {
  createRepetitionGuard, describeRepetition, type Repetition,
} from '../src/agent/repetition-guard.js';

/**
 * The failure this exists for: stepfun/step-3.5-flash, asked to produce a large
 * HTML page, collapsed into "Writing the HTML structure... " several hundred
 * times, spent its entire 16,384-token output allowance, returned stopReason
 * 'limit', and produced nothing. The harness noticed nothing — text chunks were
 * appended and printed no matter what they said.
 */

/** Feed `text` to a guard the way a stream would, in small chunks. */
function stream(text: string, chunk = 24): Repetition | null {
  const guard = createRepetitionGuard();
  for (let i = 0; i < text.length; i += chunk) {
    const hit = guard.push(text.slice(i, i + chunk));
    if (hit) return hit;
  }
  return guard.tripped;
}

describe('repetition guard', () => {
  it('catches the real-world collapse', () => {
    const hit = stream('Writing the HTML structure... '.repeat(300));
    expect(hit).not.toBeNull();
    expect(hit!.unit).toContain('Writing the HTML structure');
    expect(hit!.reps).toBeGreaterThanOrEqual(10);
  });

  it('trips early enough to matter, not after the whole reply', () => {
    // The point is to stop paying for the loop. It must fire on a few KB, not
    // on the ~65 KB a 16k-token output allowance buys.
    const phrase = 'Writing the HTML structure... ';
    const guard = createRepetitionGuard();
    let fed = 0;
    for (let i = 0; i < 2000; i++) {
      fed += phrase.length;
      if (guard.push(phrase)) break;
    }
    expect(guard.tripped).not.toBeNull();
    expect(fed).toBeLessThan(4000);
  });

  it('catches a two-phrase cycle, not just one repeated phrase', () => {
    const hit = stream('Building the structure... Writing the file now... '.repeat(60));
    expect(hit).not.toBeNull();
  });

  it('catches a degenerate single-character run', () => {
    const hit = stream('A'.repeat(4000));
    expect(hit).not.toBeNull();
  });

  it('leaves ordinary prose alone', () => {
    const prose = [
      'The auth module signs tokens with a rotating key.',
      'Sessions persist to disk after every turn so :resume can pick them up.',
      'Compaction fires at 55% of the context window, then again at 70%.',
      'Nothing here repeats verbatim, which is the whole point of this case.',
    ].join(' ');
    expect(stream(prose.repeat(8))).toBeNull();
  });

  it('leaves a long file full of repetitive but real content alone', () => {
    // Legitimately repetitive output: similar-looking lines that still differ.
    let html = '';
    for (let i = 0; i < 400; i++) {
      html += `  <div class="row" data-index="${i}"><span>Item ${i}</span></div>\n`;
    }
    expect(stream(html)).toBeNull();
  });

  it('does not fire on a handful of identical short lines', () => {
    expect(stream('| --- | --- |\n'.repeat(9))).toBeNull();
  });

  it('keeps reporting the same collapse once tripped', () => {
    const guard = createRepetitionGuard();
    let first: Repetition | null = null;
    for (let i = 0; i < 500 && !first; i++) first = guard.push('Writing the HTML structure... ');
    expect(first).not.toBeNull();
    expect(guard.push('anything at all')).toBe(first);
    expect(guard.tripped).toBe(first);
  });

  it('survives empty chunks and short streams', () => {
    const guard = createRepetitionGuard();
    expect(guard.push('')).toBeNull();
    expect(guard.push('hi')).toBeNull();
    expect(guard.tripped).toBeNull();
  });

  it('describes a collapse on one line, whitespace collapsed', () => {
    const hit = stream('Writing the HTML structure...\n\n'.repeat(200))!;
    const desc = describeRepetition(hit);
    expect(desc).not.toContain('\n');
    expect(desc).toMatch(/repeated ".*" \d+× \([\d,]+ chars\)/);
  });
});
