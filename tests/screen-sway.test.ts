import { describe, expect, it } from 'vitest';
import { keyArgs } from '../src/tools/screen/sway';

describe('keyArgs', () => {
  it('translates modifier combo to wtype press/release args', () => {
    expect(keyArgs('ctrl+shift+t')).toEqual([
      '-M', 'ctrl', '-M', 'shift', 't', '-m', 'shift', '-m', 'ctrl',
    ]);
  });

  it('passes a bare character through with no modifier args', () => {
    expect(keyArgs('a')).toEqual(['a']);
  });

  it('maps named keys via -k', () => {
    expect(keyArgs('Return')).toEqual(['-k', 'Return']);
    expect(keyArgs('f5')).toEqual(['-k', 'F5']);
  });

  it('normalizes case and whitespace', () => {
    expect(keyArgs(' Ctrl + A ')).toEqual(['-M', 'ctrl', 'a', '-m', 'ctrl']);
  });

  it('rejects unknown modifiers and keys and empty combos', () => {
    expect(() => keyArgs('hyper+x')).toThrow(/unknown modifier/);
    expect(() => keyArgs('ctrl+foo')).toThrow(/unknown key/);
    expect(() => keyArgs('')).toThrow(/empty key combo/);
  });
});
