import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../src/tools/audio-transcribe.js', () => ({
  callGroqWhisper: vi.fn(),
}));

import { callGroqWhisper } from '../src/tools/audio-transcribe.js';
import {
  downloadTelegramFile,
  textToSpeech,
  sendVoiceMessage,
  transcribeVoiceMessage,
} from '../src/tools/telegram-voice.js';

const mockCallGroqWhisper = callGroqWhisper as unknown as ReturnType<typeof vi.fn>;
const FAKE_TOKEN = 'fake-bot-token';

let fetchSpy: ReturnType<typeof vi.fn>;
let originalGroqKey: string | undefined;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  mockCallGroqWhisper.mockReset();
  originalGroqKey = process.env.GROQ_API_KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalGroqKey;
});

function jsonResponse(data: any, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}
function bufferResponse(bytes: Uint8Array, ok = true, status = 200) {
  return { ok, status, arrayBuffer: async () => bytes.buffer, text: async () => 'error body' };
}

describe('downloadTelegramFile', () => {
  it('calls getFile then downloads from the resulting file_path, writing real bytes to disk', async () => {
    const fakeBytes = new Uint8Array([1, 2, 3, 4]);
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: 'voice/abc123.oga' } }))
      .mockResolvedValueOnce(bufferResponse(fakeBytes));

    const localPath = await downloadTelegramFile(FAKE_TOKEN, 'file-id-1');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toContain('/getFile?file_id=file-id-1');
    expect(fetchSpy.mock.calls[1][0]).toBe(`https://api.telegram.org/file/bot${FAKE_TOKEN}/voice/abc123.oga`);
    expect(fs.existsSync(localPath)).toBe(true);
    expect(fs.readFileSync(localPath)).toEqual(Buffer.from(fakeBytes));
    fs.rmSync(localPath);
  });

  it('throws if getFile does not return a file_path', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true, result: {} }));
    await expect(downloadTelegramFile(FAKE_TOKEN, 'file-id-2')).rejects.toThrow(/file_path/);
  });

  it('throws if the file download itself fails', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: 'voice/x.oga' } }))
      .mockResolvedValueOnce(bufferResponse(new Uint8Array(), false, 404));
    await expect(downloadTelegramFile(FAKE_TOKEN, 'file-id-3')).rejects.toThrow(/404/);
  });
});

describe('textToSpeech', () => {
  it('requests ogg format and the expected model, returning raw audio bytes', async () => {
    const fakeAudio = new Uint8Array([9, 9, 9]);
    fetchSpy.mockResolvedValueOnce(bufferResponse(fakeAudio));

    const result = await textToSpeech('hello there', 'groq-key');

    expect(result).toEqual(Buffer.from(fakeAudio));
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/speech');
    const body = JSON.parse((opts as any).body);
    expect(body.response_format).toBe('ogg');
    expect(body.model).toBe('playai-tts');
    expect(body.input).toBe('hello there');
  });

  it('truncates text longer than the cap before sending, never silently failing on long task summaries', async () => {
    fetchSpy.mockResolvedValueOnce(bufferResponse(new Uint8Array([1])));
    const longText = 'x'.repeat(2000);
    await textToSpeech(longText, 'groq-key');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body);
    expect(body.input.length).toBeLessThan(longText.length);
    expect(body.input).toContain('see full message above');
  });

  it('throws with the response body on API failure', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad voice id' });
    await expect(textToSpeech('hi', 'groq-key')).rejects.toThrow(/400.*bad voice id/);
  });
});

describe('sendVoiceMessage', () => {
  it('posts multipart form data to sendVoice with the audio attached', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });
    await sendVoiceMessage(FAKE_TOKEN, 12345, Buffer.from([1, 2, 3]));

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendVoice`);
    expect((opts as any).body).toBeInstanceOf(FormData);
  });

  it('throws on a non-ok response', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'forbidden' });
    await expect(sendVoiceMessage(FAKE_TOKEN, 1, Buffer.from([1]))).rejects.toThrow(/403.*forbidden/);
  });
});

describe('transcribeVoiceMessage', () => {
  it('throws clearly if GROQ_API_KEY is not set, before attempting any download', async () => {
    delete process.env.GROQ_API_KEY;
    await expect(transcribeVoiceMessage(FAKE_TOKEN, 'file-id')).rejects.toThrow(/GROQ_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('downloads, transcribes via callGroqWhisper, and returns the trimmed raw text', async () => {
    process.env.GROQ_API_KEY = 'real-groq-key';
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: 'voice/y.oga' } }))
      .mockResolvedValueOnce(bufferResponse(new Uint8Array([5, 5])));
    mockCallGroqWhisper.mockResolvedValueOnce({ text: '  fix the login bug  ' });

    const result = await transcribeVoiceMessage(FAKE_TOKEN, 'file-id-4');

    expect(result).toBe('fix the login bug');
    expect(mockCallGroqWhisper).toHaveBeenCalledWith(expect.stringContaining('tg-voice-file-id-4'), 'real-groq-key');
  });

  it('cleans up the downloaded temp file even when transcription fails', async () => {
    process.env.GROQ_API_KEY = 'real-groq-key';
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: 'voice/z.oga' } }))
      .mockResolvedValueOnce(bufferResponse(new Uint8Array([1])));
    mockCallGroqWhisper.mockRejectedValueOnce(new Error('whisper exploded'));

    await expect(transcribeVoiceMessage(FAKE_TOKEN, 'file-id-5')).rejects.toThrow('whisper exploded');

    // give the best-effort fs.rm callback a tick to run
    await new Promise(r => setTimeout(r, 50));
    const expectedPath = path.join(os.tmpdir(), 'tg-voice-file-id-5.oga');
    expect(fs.existsSync(expectedPath)).toBe(false);
  });
});
