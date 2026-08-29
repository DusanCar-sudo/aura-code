import { describe, it, expect } from 'vitest';
import { LOCALES, translate, type Locale } from '../../web/src/i18n';

// A missing translation is invisible in review — the app just shows English,
// or worse, a raw key like "settings.sandboxHint". These catch that.

const CODES = Object.keys(LOCALES) as Locale[];

/** Every key English defines. English is the reference by construction. */
const KEYS: string[] = (() => {
  const found = new Set<string>();
  // translate() falls back to English, so probing with English's own keys is
  // the only way to enumerate them without exporting the dictionaries.
  const src = new URL('../../web/src/i18n/index.ts', import.meta.url);
  const text = require('fs').readFileSync(src, 'utf8') as string;
  const block = text.slice(text.indexOf('const en: Dict = {'), text.indexOf('const sr: Dict = {'));
  for (const m of block.matchAll(/^\s{2}'([a-z][\w.]+)':/gm)) found.add(m[1]);
  return [...found];
})();

describe('locales', () => {
  it('has the seven the owner asked for, and Serbian is Cyrillic', () => {
    expect(CODES.sort()).toEqual(['ar', 'en', 'es', 'fr', 'it', 'ru', 'sr']);
    expect(LOCALES.sr.native).toBe('Српски');
  });

  it('marks Arabic as the only right-to-left locale', () => {
    expect(LOCALES.ar.dir).toBe('rtl');
    for (const c of CODES.filter(x => x !== 'ar')) expect(LOCALES[c].dir).toBe('ltr');
  });

  it('found a real key set to check against', () => {
    expect(KEYS.length).toBeGreaterThan(60);
  });

  it('translates every key in every locale, with nothing falling back to the key', () => {
    const missing: string[] = [];
    for (const code of CODES) {
      for (const key of KEYS) {
        const value = translate(code, key);
        if (value === key) missing.push(`${code}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('actually translates rather than echoing English', () => {
    // A locale that returned English for everything would pass the check above.
    for (const code of CODES.filter(c => c !== 'en')) {
      const differences = KEYS.filter(k => translate(code, k) !== translate('en', k));
      expect(differences.length).toBeGreaterThan(KEYS.length * 0.5);
    }
  });

  it('defines every key the components build at runtime', () => {
    // The check above can only see keys that already exist in `en`. A key the
    // UI composes — `board.col.${column}` — is invisible to it, so a missing
    // one ships and renders as the raw key on screen. That is exactly what
    // happened to board.col.execution; this is the guard.
    const dynamic = [
      ...['planning', 'preparation', 'execution', 'finished'].map((c) => `board.col.${c}`),
      ...['chat', 'board'].map((v) => `view.${v}`),
    ];
    const missing: string[] = [];
    for (const code of CODES) {
      for (const key of dynamic) {
        if (translate(code, key) === key) missing.push(`${code}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('falls back to English for an unknown key rather than throwing', () => {
    expect(() => translate('fr', 'no.such.key')).not.toThrow();
    expect(translate('fr', 'no.such.key')).toBe('no.such.key');
  });
});
