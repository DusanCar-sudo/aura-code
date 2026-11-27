import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchLiveModels } from '../../src/providers/live-models.js';

/**
 * Regression cover for the AI Studio catalogue.
 *
 * Two bugs this pins down:
 *   1. No pagination — the endpoint defaults to 50 entries per page and AI
 *      Studio now serves 60+, so the newest models never showed up in /model.
 *   2. No capability filter — every generateContent model was offered as a
 *      chat model, including image, TTS, music (lyria), video (veo),
 *      embeddings and live/bidi audio. Switching to one failed on first use.
 */
describe('google live models: paginated and chat-only', () => {
  const savedKey = process.env.GOOGLE_API_KEY;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = savedKey;
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function page(models: object[], nextPageToken?: string) {
    return { ok: true, json: async () => ({ models, nextPageToken }) } as unknown as Response;
  }

  const chat = (id: string) => ({
    name: `models/${id}`,
    displayName: id,
    supportedGenerationMethods: ['generateContent', 'countTokens'],
  });

  it('follows nextPageToken instead of stopping after the first page', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      if (url.searchParams.get('pageToken') === 'p2') {
        return page([chat('gemini-3.8-flash')]);
      }
      return page([chat('gemini-3.7-flash')], 'p2');
    }) as unknown as typeof fetch;

    const ids = (await fetchLiveModels('gemini')).map((m) => m.id);
    expect(ids).toEqual(['gemini/gemini-3.7-flash', 'gemini/gemini-3.8-flash']);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('pageToken=p2');
  });

  it('drops non-chat models that technically answer generateContent', async () => {
    globalThis.fetch = (async () =>
      page([
        chat('gemini-3.8-flash'),
        chat('gemini-3.1-flash-image'),
        chat('gemini-2.5-flash-preview-tts'),
        chat('gemini-2.5-flash-native-audio-dialog'),
        chat('lyria-3-pro'),
        chat('veo-3.1-generate'),
        chat('imagen-4-ultra'),
        chat('nano-banana-2'),
        chat('text-embedding-005'),
        chat('deep-research-pro-preview'),
      ])) as unknown as typeof fetch;

    const ids = (await fetchLiveModels('gemini')).map((m) => m.id);
    expect(ids).toEqual(['gemini/gemini-3.8-flash']);
  });

  it('still excludes models that cannot generateContent at all', async () => {
    globalThis.fetch = (async () =>
      page([
        chat('gemini-3.8-flash'),
        { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
      ])) as unknown as typeof fetch;

    const ids = (await fetchLiveModels('gemini')).map((m) => m.id);
    expect(ids).toEqual(['gemini/gemini-3.8-flash']);
  });

  it('deduplicates ids repeated across pages', async () => {
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get('pageToken') === 'p2') {
        return page([chat('gemini-3.8-flash')]);
      }
      return page([chat('gemini-3.8-flash')], 'p2');
    }) as unknown as typeof fetch;

    const ids = (await fetchLiveModels('gemini')).map((m) => m.id);
    expect(ids).toEqual(['gemini/gemini-3.8-flash']);
  });
});
