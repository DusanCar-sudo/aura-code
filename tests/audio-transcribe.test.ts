import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { audioTranscribe, AUDIO_TRANSCRIBE_DEFINITION } from '../src/tools/audio-transcribe.js';

const testDir = path.join(os.tmpdir(), 'ruby-test-audio-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(testDir, { recursive: true });
  // Create a fake MP3 file (minimal header)
  fs.writeFileSync(path.join(testDir, 'test.mp3'), Buffer.from([0xFF, 0xFB, 0x90, 0x00]));
  // Create a fake WAV file
  fs.writeFileSync(path.join(testDir, 'test.wav'), Buffer.from([0x52, 0x49, 0x46, 0x46]));
  // Create a non-audio file
  fs.writeFileSync(path.join(testDir, 'text.txt'), 'hello');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('AUDIO_TRANSCRIBE_DEFINITION', () => {
  it('has correct name', () => {
    expect(AUDIO_TRANSCRIBE_DEFINITION.name).toBe('audio_transcribe');
  });

  it('requires path', () => {
    expect(AUDIO_TRANSCRIBE_DEFINITION.parameters.required).toEqual(['path']);
  });
});

describe('audioTranscribe — info', () => {
  it('returns file info for valid audio', async () => {
    const r = await audioTranscribe({ path: path.join(testDir, 'test.mp3'), action: 'info' });
    expect(r).toContain('File:');
    expect(r).toContain('Size:');
    expect(r).toContain('MP3');
    expect(r).toContain('whisper-large-v3-turbo');
  });

  it('returns error for missing file', async () => {
    const r = await audioTranscribe({ path: '/nonexistent/audio.mp3' });
    expect(r).toContain('Error: File not found');
  });

  it('returns error for non-audio file', async () => {
    const r = await audioTranscribe({ path: path.join(testDir, 'text.txt'), action: 'info' });
    expect(r).toContain('Error: Not an audio file');
  });

  it('returns info for wav files', async () => {
    const r = await audioTranscribe({ path: path.join(testDir, 'test.wav'), action: 'info' });
    expect(r).toContain('WAV');
  });
});

describe('audioTranscribe — transcribe', () => {
  it('returns error when GROQ_API_KEY not set', async () => {
    const originalKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const r = await audioTranscribe({ path: path.join(testDir, 'test.mp3') });
    expect(r).toContain('GROQ_API_KEY not set');
    if (originalKey) process.env.GROQ_API_KEY = originalKey;
  });

  it('returns error for non-audio extension', async () => {
    const r = await audioTranscribe({ path: path.join(testDir, 'text.txt') });
    expect(r).toContain('Error: Not an audio file');
  });

  it('returns error for missing file on transcribe', async () => {
    const r = await audioTranscribe({ path: '/nonexistent/audio.mp3' });
    expect(r).toContain('Error: File not found');
  });
});
