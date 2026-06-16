import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// YouTube Transcript — extract captions/subtitles from YouTube videos
// No API key required. Parses the page HTML to find caption track URLs.
// ─────────────────────────────────────────────────────────────────────────────

export interface YouTubeTranscriptInput {
  url: string;
  lang?: string;
  format?: 'text' | 'timestamps' | 'srt';
  max_chars?: number;
}

export const YOUTUBE_TRANSCRIPT_DEFINITION: ToolDefinition = {
  name: 'youtube_transcript',
  description:
    'Extract transcript/captions from a YouTube video. Works with regular videos and Shorts. ' +
    'No API key required. Supports multiple languages and output formats.',
  parameters: {
    type: 'object',
    properties: {
      url:        { type: 'string', description: 'YouTube video URL or video ID' },
      lang:       { type: 'string', description: 'Caption language code (default: en). Use "list" to see available languages.' },
      format:     { type: 'string', description: 'Output format: "text" (plain text), "timestamps" (with timestamps), "srt" (SRT subtitle format). Default: timestamps' },
      max_chars:  { type: 'number', description: 'Max characters to return (default: 50000)' },
    },
    required: ['url'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractVideoId(input: string): string | null {
  // Handle direct video IDs
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

  const patterns = [
    /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: string;
  isTranslatable: boolean;
}

interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}

function parseTimedText(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];

  // YouTube returns XML like: <p t="0" d="5000">Hello world</p>
  // or newer format: <text start="0" dur="5">Hello world</text>
  const pRegex = /<p\s[^>]*t="(\d+)"[^>]*d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;

  while ((m = pRegex.exec(xml)) !== null) {
    const start = parseInt(m[1], 10) / 1000;
    const duration = parseInt(m[2], 10) / 1000;
    const text = m[3]
      .replace(/<[^>]+>/g, '')      // strip HTML tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/\n/g, ' ')
      .trim();

    if (text) segments.push({ start, duration, text });
  }

  // Fallback: try <text start="..." dur="..."> format
  if (segments.length === 0) {
    const textRegex = /<text\s[^>]*start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    while ((m = textRegex.exec(xml)) !== null) {
      const start = parseFloat(m[1]);
      const duration = parseFloat(m[2]);
      const text = m[3]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/\n/g, ' ')
        .trim();

      if (text) segments.push({ start, duration, text });
    }
  }

  return segments;
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSrtTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatTranscript(segments: TranscriptSegment[], format: string): string {
  switch (format) {
    case 'text':
      return segments.map(s => s.text).join(' ');

    case 'srt':
      return segments.map((s, i) => {
        const end = s.start + s.duration;
        return `${i + 1}\n${formatSrtTimestamp(s.start)} --> ${formatSrtTimestamp(end)}\n${s.text}\n`;
      }).join('\n');

    case 'timestamps':
    default:
      return segments.map(s => `[${formatTimestamp(s.start)}] ${s.text}`).join('\n');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main executor
// ─────────────────────────────────────────────────────────────────────────────

export async function youtubeTranscript(input: YouTubeTranscriptInput): Promise<string> {
  const maxChars = input.max_chars ?? 50_000;
  const format = input.format ?? 'timestamps';
  const lang = input.lang ?? 'en';

  // 1. Extract video ID
  const videoId = extractVideoId(input.url);
  if (!videoId) {
    return `Error: Could not extract video ID from: "${input.url}"\nSupported formats: https://youtube.com/watch?v=ID, https://youtu.be/ID, https://youtube.com/shorts/ID`;
  }

  try {
    // 2. Fetch the YouTube page to find caption tracks
    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return `Error: YouTube returned HTTP ${response.status}`;
    }

    const html = await response.text();

    // 3. Extract ytInitialPlayerResponse from the page
    // Use [\s\S] instead of /s flag for compatibility with older TS targets
    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});\s*(?:var\s|<\/script)/);
    if (!playerMatch) {
      return 'Error: Could not extract player data from YouTube page. The video may be private, age-restricted, or YouTube changed their page structure.';
    }

    const playerJson = playerMatch[1];

    let playerData: any;
    try {
      playerData = JSON.parse(playerJson);
    } catch {
      return 'Error: Failed to parse YouTube player data JSON.';
    }

    // 4. Navigate to caption tracks
    const captions = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captions || captions.length === 0) {
      const videoDetails = playerData?.videoDetails;
      const title = videoDetails?.title ?? 'Unknown';
      return `No captions available for: "${title}" (${videoId})\nThe video may not have subtitles or auto-generated captions.`;
    }

    // 5. If lang=list, show available languages
    if (lang === 'list') {
      const tracks = captions.map((t: CaptionTrack) =>
        `  - ${t.languageCode}: ${t.name}${t.isTranslatable ? ' (translatable)' : ''}`
      );
      return `Available caption tracks for ${videoId}:\n${tracks.join('\n')}`;
    }

    // 6. Find the requested language track
    let track: CaptionTrack | undefined = captions.find((t: CaptionTrack) => t.languageCode === lang);
    if (!track) {
      // Try partial match (e.g., "en" matches "en-US")
      track = captions.find((t: CaptionTrack) => t.languageCode.startsWith(lang));
    }
    if (!track) {
      // Fall back to first available
      track = captions[0];
      if (!track) {
        return `Error: No caption track found for language "${lang}".`;
      }
    }

    // 7. Fetch the caption XML
    // Remove fmt=srv3 to get simpler XML
    const captionUrl = track.baseUrl.replace(/&fmt=\w+/, '');
    const captionResponse = await fetch(captionUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!captionResponse.ok) {
      return `Error: Failed to fetch captions (HTTP ${captionResponse.status})`;
    }

    const captionXml = await captionResponse.text();

    // 8. Parse the timed text
    const segments = parseTimedText(captionXml);
    if (segments.length === 0) {
      return `Error: No caption segments found in the response for language "${track.languageCode}".`;
    }

    // 9. Format and return
    const videoDetails = playerData?.videoDetails;
    const title = videoDetails?.title ?? 'Unknown';
    const duration = videoDetails?.lengthSeconds ? `${Math.floor(parseInt(videoDetails.lengthSeconds) / 60)}m${parseInt(videoDetails.lengthSeconds) % 60}s` : '?';

    const header = `YouTube Transcript: "${title}" (${duration})\nLanguage: ${track.languageCode} | Segments: ${segments.length}\nURL: ${pageUrl}\n\n`;
    const body = formatTranscript(segments, format);

    const result = header + body;
    if (result.length > maxChars) {
      return result.slice(0, maxChars) + `\n\n... [truncated at ${maxChars} chars]`;
    }
    return result;

  } catch (e: any) {
    return `Error fetching YouTube transcript: ${e?.message ?? String(e)}`;
  }
}
