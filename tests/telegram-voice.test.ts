import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

// Mock child_process's callback-style exec. Node's real exec has a special
// util.promisify.custom implementation that resolves promisify(exec)(...)
// to {stdout, stderr} as an object — a plain vi.fn() callback mock does
// NOT replicate that (generic promisify only resolves to the single first
// callback argument), so it has to be attached explicitly here, or the
// real implementation's `const {stdout} = await execAsync(...)` would
// silently destructure off the wrong shape during tests.
//
// vi.hoisted() is required here, not just a plain top-level const — vi.mock()
// factories are hoisted above all imports/variables in the file, so anything
// the factory references has to be created through vi.hoisted() to survive
// that reordering (the same pattern already used in telegram-safety.test.ts).
const { execMock } = vi.hoisted(() => {
  const execMock = vi.fn();
  return { execMock };
});

vi.mock('child_process', () => {
  const mockedExec: any = (...args: any[]) => execMock(...args);
  mockedExec[promisify.custom] = (cmd: string, opts?: any) =>
    new Promise((resolve, reject) => {
      execMock(cmd, opts, (err: any, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return { exec: mockedExec };
});

import {
  downloadTelegramFile,
  textToSpeech,
  sendVoiceMessage,
  transcribeVoiceMessage,
} from '../src/tools/telegram-voice.js';

import { stripWavPrefix } from '../src/tools/dictate.js';

const FAKE_TOKEN = 'fake-bot-token';

/** Queues one exec() call's result. Mirrors Node's (err, stdout, stderr) callback. */
function queueExec(handler: (cmd: string) => { stdout?: string; err?: Error }) {
  execMock.mockImplementationOnce((cmd: string, _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    const { stdout = '', err } = handler(cmd);
    cb(err ?? null, stdout, '');
  });
}

let originalGroqKey: string | undefined;

beforeEach(() => {
  execMock.mockReset();
  originalGroqKey = process.env.GROQ_API_KEY;
});
afterEach(() => {
  if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalGroqKey;
});

describe('downloadTelegramFile', () => {
  it('calls getFile, then downloads to a local temp path via curl -o', async () => {
    queueExec(() => ({ stdout: JSON.stringify({ ok: true, result: { file_path: 'voice/abc.oga' } }) }));
    // The second exec call is the actual download — it writes via curl -o,
    // so the mock needs to actually create the file for the existence/size check.
    let downloadedPath = '';
    execMock.mockImplementationOnce((cmd: string, _opts: any, cb: any) => {
      const match = cmd.match(/-o "([^"]+)"/);
      downloadedPath = match![1];
      fs.writeFileSync(downloadedPath, Buffer.from([1, 2, 3]));
      cb(null, '', '');
    });

    const result = await downloadTelegramFile(FAKE_TOKEN, 'file-id-1');

    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[0][0]).toContain('getFile?file_id=file-id-1');
    expect(execMock.mock.calls[1][0]).toContain(`/file/bot${FAKE_TOKEN}/voice/abc.oga`);
    expect(result).toBe(downloadedPath);
    expect(fs.existsSync(result)).toBe(true);
    fs.rmSync(result);
  });

  it('throws on a Telegram-level error response', async () => {
    queueExec(() => ({ stdout: JSON.stringify({ ok: false, description: 'file not found', error_code: 400 }) }));
    await expect(downloadTelegramFile(FAKE_TOKEN, 'bad-id')).rejects.toThrow(/file not found/);
  });

  it('throws if getFile returns no file_path', async () => {
    queueExec(() => ({ stdout: JSON.stringify({ ok: true, result: {} }) }));
    await expect(downloadTelegramFile(FAKE_TOKEN, 'file-id-2')).rejects.toThrow(/file_path/);
  });

  it('throws if the downloaded file ends up empty (curl silently failed)', async () => {
    queueExec(() => ({ stdout: JSON.stringify({ ok: true, result: { file_path: 'voice/x.oga' } }) }));
    execMock.mockImplementationOnce((cmd: string, _opts: any, cb: any) => {
      // Simulate curl "succeeding" (no thrown error) but writing nothing —
      // a real failure mode for curl -o against an unreachable/erroring URL.
      cb(null, '', '');
    });
    await expect(downloadTelegramFile(FAKE_TOKEN, 'file-id-3')).rejects.toThrow(/empty/);
  });
});

describe('stripWavPrefix', () => {

  it('strips leading CRLF (0x0D 0x0A) from a corrupted WAV buffer', () => {
    const clean = Buffer.from('RIFF....WAVE....', 'utf8');
    const corrupted = Buffer.concat([Buffer.from([0x0D, 0x0A]), clean]);
    const result = stripWavPrefix(corrupted);
    expect(result).toEqual(clean);
    expect(result.length).toBe(clean.length);
  });

  it('passes a clean buffer through unchanged', () => {
    const buf = Buffer.from('RIFF....WAVE....', 'utf8');
    const result = stripWavPrefix(buf);
    expect(result).toEqual(buf);
  });

  it('passes a buffer with only a single 0x0D (no 0x0A) through unchanged', () => {
    const buf = Buffer.from([0x0D, ...Buffer.from('RIFF', 'utf8')]);
    const result = stripWavPrefix(buf);
    expect(result).toEqual(buf);
  });

  it('handles empty buffer without error', () => {
    const result = stripWavPrefix(Buffer.alloc(0));
    expect(result).toEqual(Buffer.alloc(0));
  });

  it('handles a 1-byte buffer without error', () => {
    const buf = Buffer.from([0x0D]);
    const result = stripWavPrefix(buf);
    expect(result).toEqual(buf);
  });
});

describe('textToSpeech', () => {
  it('requests ogg/playai-tts and returns the written audio bytes', async () => {
    const fakeAudio = Buffer.from([9, 9, 9]);
    execMock.mockImplementationOnce((cmd: string, _opts: any, cb: any) => {
      const match = cmd.match(/-o "([^"]+)"/);
      fs.writeFileSync(match![1], fakeAudio);
      cb(null, '', '');
    });

    const result = await textToSpeech('hello there', 'groq-key');
    expect(result).toEqual(fakeAudio);

    const sentCmd = execMock.mock.calls[0][0] as string;
    expect(sentCmd).toContain('playai-tts');
    expect(sentCmd).toContain('"response_format":"ogg"');
  });

  it('truncates text longer than the cap before sending', async () => {
    let sentBody = '';
    execMock.mockImplementationOnce((cmd: string, _opts: any, cb: any) => {
      sentBody = cmd;
      const match = cmd.match(/-o "([^"]+)"/);
      fs.writeFileSync(match![1], Buffer.from([1]));
      cb(null, '', '');
    });
    const longText = 'x'.repeat(2000);
    await textToSpeech(longText, 'groq-key');
    expect(sentBody).toContain('see full message above');
    expect(sentBody.length).toBeLessThan(longText.length + 500);
  });

  it('throws with the real error body when curl -f fails, by re-running without -f', async () => {
    // First call: curl -f exits non-zero on HTTP error.
    execMock.mockImplementationOnce((_cmd: string, _opts: any, cb: any) => {
      cb(new Error('curl: (22) The requested URL returned error: 400'), '', '');
    });
    // Second call: re-run without -f, capture the real error body.
    execMock.mockImplementationOnce((cmd: string, _opts: any, cb: any) => {
      const match = cmd.match(/-o "([^"]+)"/);
      fs.writeFileSync(match![1], 'invalid voice id requested');
      cb(null, '', '');
    });

    await expect(textToSpeech('hi', 'groq-key')).rejects.toThrow(/invalid voice id requested/);
  });
});

describe('sendVoiceMessage', () => {
  it('writes the buffer to a temp file and uploads it via curl -F', async () => {
    let uploadedFilePath = '';
    execMock.mockImplementationOnce((cmd: string, _opts: any, cb: any) => {
      const match = cmd.match(/voice=@([^\s"]+)/);
      uploadedFilePath = match![1];
      expect(fs.existsSync(uploadedFilePath)).toBe(true);
      expect(fs.readFileSync(uploadedFilePath)).toEqual(Buffer.from([1, 2, 3]));
      cb(null, JSON.stringify({ ok: true, result: {} }), '');
    });

    await sendVoiceMessage(FAKE_TOKEN, 12345, Buffer.from([1, 2, 3]));

    // cleanup uses a fire-and-forget fs.rm callback, deliberately not
    // awaited so a slow filesystem can't block the response — give it a
    // tick to actually run before checking it happened.
    await new Promise(r => setTimeout(r, 50));
    expect(fs.existsSync(uploadedFilePath)).toBe(false);
  });

  it('throws on a Telegram-level error response', async () => {
    execMock.mockImplementationOnce((_cmd: string, _opts: any, cb: any) => {
      cb(null, JSON.stringify({ ok: false, description: 'chat not found', error_code: 400 }), '');
    });
    await expect(sendVoiceMessage(FAKE_TOKEN, 1, Buffer.from([1]))).rejects.toThrow(/chat not found/);
  });
});

describe('transcribeVoiceMessage', () => {
  it('throws clearly if GROQ_API_KEY is not set, before attempting any download', async () => {
    delete process.env.GROQ_API_KEY;
    await expect(transcribeVoiceMessage(FAKE_TOKEN, 'file-id')).rejects.toThrow(/GROQ_API_KEY/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('downloads, transcribes via curl, and returns trimmed text', async () => {
    process.env.GROQ_API_KEY = 'real-groq-key';
    // getFile
    queueExec(() => ({ stdout: JSON.stringify({ ok: true, result: { file_path: 'voice/y.oga' } }) }));
    // download
    execMock.mockImplementationOnce((cmd: string, _opts: any, cb: any) => {
      const match = cmd.match(/-o "([^"]+)"/);
      fs.writeFileSync(match![1], Buffer.from([5, 5]));
      cb(null, '', '');
    });
    // whisper call
    execMock.mockImplementationOnce((cmd: string, _opts: any, cb: any) => {
      const match = cmd.match(/-o "([^"]+)"/);
      fs.writeFileSync(match![1], JSON.stringify({ text: '  fix the login bug  ' }));
      cb(null, '', '');
    });

    const result = await transcribeVoiceMessage(FAKE_TOKEN, 'file-id-4');
    expect(result).toBe('fix the login bug');
  });

  it('surfaces a Whisper API error clearly', async () => {
    process.env.GROQ_API_KEY = 'real-groq-key';
    queueExec(() => ({ stdout: JSON.stringify({ ok: true, result: { file_path: 'voice/z.oga' } }) }));
    execMock.mockImplementationOnce((cmd: string, _opts: any, cb: any) => {
      const match = cmd.match(/-o "([^"]+)"/);
      fs.writeFileSync(match![1], Buffer.from([1]));
      cb(null, '', '');
    });
    execMock.mockImplementationOnce((cmd: string, _opts: any, cb: any) => {
      const match = cmd.match(/-o "([^"]+)"/);
      fs.writeFileSync(match![1], JSON.stringify({ error: { message: 'audio too short' } }));
      cb(null, '', '');
    });

    await expect(transcribeVoiceMessage(FAKE_TOKEN, 'file-id-5')).rejects.toThrow(/audio too short/);
  });
});
