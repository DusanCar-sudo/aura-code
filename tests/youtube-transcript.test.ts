import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { youtubeTranscript, YOUTUBE_TRANSCRIPT_DEFINITION } from '../src/tools/youtube-transcript.js';

const mockFetch = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', mockFetch); mockFetch.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('YOUTUBE_TRANSCRIPT_DEFINITION', () => {
  it('has correct name', () => expect(YOUTUBE_TRANSCRIPT_DEFINITION.name).toBe('youtube_transcript'));
  it('requires url', () => expect(YOUTUBE_TRANSCRIPT_DEFINITION.parameters.required).toEqual(['url']));
  it('has lang property', () => expect(YOUTUBE_TRANSCRIPT_DEFINITION.parameters.properties.lang).toBeDefined());
  it('has format property', () => expect(YOUTUBE_TRANSCRIPT_DEFINITION.parameters.properties.format).toBeDefined());
});

describe('youtubeTranscript — URL parsing', () => {
  it('returns error for invalid URL', async () => {
    const r = await youtubeTranscript({ url: 'not-a-valid-url' });
    expect(r).toContain('Error');
    expect(r).toContain('Could not extract video ID');
  });

  it('accepts direct 11-char video ID', async () => {
    // Will fail on fetch, but should NOT fail on ID parsing
    mockFetch.mockRejectedValueOnce(new Error('network'));
    const r = await youtubeTranscript({ url: 'dQw4w9WgXcQ' });
    expect(r).not.toContain('Could not extract video ID');
  });

  it('accepts youtube.com/watch URL', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));
    const r = await youtubeTranscript({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(r).not.toContain('Could not extract video ID');
  });

  it('accepts youtube.com/shorts URL', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));
    const r = await youtubeTranscript({ url: 'https://youtube.com/shorts/EZjCiualSQk' });
    expect(r).not.toContain('Could not extract video ID');
  });

  it('accepts youtu.be short URL', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));
    const r = await youtubeTranscript({ url: 'https://youtu.be/dQw4w9WgXcQ' });
    expect(r).not.toContain('Could not extract video ID');
  });

  it('accepts embed URL', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));
    const r = await youtubeTranscript({ url: 'https://www.youtube.com/embed/dQw4w9WgXcQ' });
    expect(r).not.toContain('Could not extract video ID');
  });
});

describe('youtubeTranscript — page fetch errors', () => {
  it('handles HTTP error from YouTube', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const r = await youtubeTranscript({ url: 'dQw4w9WgXcQ' });
    expect(r).toContain('Error');
    expect(r).toContain('404');
  });

  it('handles network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    const r = await youtubeTranscript({ url: 'dQw4w9WgXcQ' });
    expect(r).toContain('Error');
  });
});

describe('youtubeTranscript — successful extraction', () => {
  it('extracts transcript from mocked YouTube page', async () => {
    const mockPlayerResponse = JSON.stringify({
      videoDetails: {
        title: 'Test Video',
        lengthSeconds: '120',
      },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{
            baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en',
            languageCode: 'en',
            name: 'English',
            isTranslatable: false,
          }],
        },
      },
    });

    // Mock the YouTube page
    const pageHtml = `<html><script>var ytInitialPlayerResponse = ${mockPlayerResponse};</script></html>`;
    mockFetch.mockResolvedValueOnce(new Response(pageHtml, { status: 200 }));

    // Mock the caption XML
    const captionXml = `<transcript><p t="0" d="5000">Hello world</p><p t="5000" d="3000">This is a test</p></transcript>`;
    mockFetch.mockResolvedValueOnce(new Response(captionXml, { status: 200 }));

    const r = await youtubeTranscript({ url: 'dQw4w9WgXcQ' });
    expect(r).toContain('Test Video');
    expect(r).toContain('Hello world');
    expect(r).toContain('This is a test');
    expect(r).toContain('0:00');
    expect(r).toContain('0:05');
  });

  it('returns plain text format when requested', async () => {
    const mockPlayerResponse = JSON.stringify({
      videoDetails: { title: 'Plain Text Test', lengthSeconds: '60' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{
            baseUrl: 'https://www.youtube.com/api/timedtext?v=test&lang=en',
            languageCode: 'en',
            name: 'English',
            isTranslatable: false,
          }],
        },
      },
    });

    const pageHtml = `<html><script>var ytInitialPlayerResponse = ${mockPlayerResponse};</script></html>`;
    mockFetch.mockResolvedValueOnce(new Response(pageHtml, { status: 200 }));

    const captionXml = `<transcript><p t="0" d="3000">First line</p><p t="3000" d="3000">Second line</p></transcript>`;
    mockFetch.mockResolvedValueOnce(new Response(captionXml, { status: 200 }));

    const r = await youtubeTranscript({ url: 'dQw4w9WgXcQ', format: 'text' });
    expect(r).toContain('First line Second line');
    expect(r).not.toContain('['); // no timestamps
  });

  it('lists available languages when lang=list', async () => {
    const mockPlayerResponse = JSON.stringify({
      videoDetails: { title: 'Lang Test', lengthSeconds: '60' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: '', languageCode: 'en', name: 'English', isTranslatable: false },
            { baseUrl: '', languageCode: 'sr', name: 'Serbian', isTranslatable: true },
          ],
        },
      },
    });

    const pageHtml = `<html><script>var ytInitialPlayerResponse = ${mockPlayerResponse};</script></html>`;
    mockFetch.mockResolvedValueOnce(new Response(pageHtml, { status: 200 }));

    const r = await youtubeTranscript({ url: 'dQw4w9WgXcQ', lang: 'list' });
    expect(r).toContain('en: English');
    expect(r).toContain('sr: Serbian');
    expect(r).toContain('translatable');
  });

  it('handles no captions available', async () => {
    const mockPlayerResponse = JSON.stringify({
      videoDetails: { title: 'No Captions', lengthSeconds: '60' },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
    });

    const pageHtml = `<html><script>var ytInitialPlayerResponse = ${mockPlayerResponse};</script></html>`;
    mockFetch.mockResolvedValueOnce(new Response(pageHtml, { status: 200 }));

    const r = await youtubeTranscript({ url: 'dQw4w9WgXcQ' });
    expect(r).toContain('No captions available');
    expect(r).toContain('No Captions');
  });
});
