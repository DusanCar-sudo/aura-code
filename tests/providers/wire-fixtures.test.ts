import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fromOpenAIResponse } from '../../src/providers/openai-compatible.js';
import { fromGoogleResponse } from '../../src/providers/google.js';
import { fromAnthropicResponse } from '../../src/providers/anthropic.js';
import type { LLMResponse } from '../../src/providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Replay recorded provider responses through the real parsers.
//
// Provider tests used to mock at the fetch boundary with nothing recorded
// behind them, so a vendor changing its wire format stayed invisible until it
// failed at runtime against a live account. These tests feed bodies actually
// captured off the wire (see README.md in the fixture dir) into the same
// functions production uses, and assert the normalized LLMResponse.
//
// Parsers, not full provider.complete(): the vendor SDKs capture `fetch` at
// import time, so a stubbed global fetch does not reach them — a "replay" test
// written that way silently makes real network calls and passes for the wrong
// reason. Observed here, which is why it is written this way instead.
//
// Four fixtures cover thirty providers because there are only four wire
// formats — the README makes that argument in full.
//
// A missing fixture SKIPS. It must never look like a pass: the classes we could
// not capture are gaps still owed, not behaviour verified.
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'providers');

interface Fixture {
  transportClass: string;
  via: string;
  capturedAt: string;
  status: number;
  body: string;
}

function loadFixture(name: string): Fixture | undefined {
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture;
}

/** Concatenate an SSE capture's `data:` payloads into parsed chunks. */
function sseChunks(body: string): unknown[] {
  return body
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(payload => payload && payload !== '[DONE]')
    .map(payload => JSON.parse(payload) as unknown);
}

/** Parse a non-streaming fixture with the parser its transport class uses. */
function parseNonStreaming(klass: string, body: string): LLMResponse {
  const json = JSON.parse(body);
  switch (klass) {
    case 'anthropic': return fromAnthropicResponse(json);
    case 'google': return fromGoogleResponse(json);
    default: return fromOpenAIResponse(json);
  }
}

const CLASSES = ['anthropic', 'google', 'openai-compatible', 'archimedes-local'] as const;

describe('recorded wire-format fixtures', () => {
  for (const klass of CLASSES) {
    describe(klass, () => {
      const nonStreaming = loadFixture(`${klass}.nonstreaming`);
      const streaming = loadFixture(`${klass}.streaming`);
      const error = loadFixture(`${klass}.error`);

      (nonStreaming ? it : it.skip)('parses a recorded completion into a normalized response', () => {
        const response = parseNonStreaming(klass, nonStreaming!.body);
        // The captured prompt asked for exactly one word, so the parse is checkable.
        expect(response.text.toLowerCase()).toContain('pong');
        expect(response.toolCalls).toEqual([]);
        expect(['done', 'tools', 'limit']).toContain(response.stopReason);
      });

      (nonStreaming ? it : it.skip)('reads token usage off the recorded response', () => {
        const response = parseNonStreaming(klass, nonStreaming!.body);
        expect(response.usage).toBeDefined();
        expect(response.usage!.inputTokens).toBeGreaterThan(0);
        expect(response.usage!.outputTokens).toBeGreaterThan(0);
      });

      (streaming ? it : it.skip)('yields the recorded stream as parseable chunks', () => {
        const chunks = sseChunks(streaming!.body);
        expect(chunks.length).toBeGreaterThan(0);
        const text = chunks.map(chunk => {
          const c = chunk as Record<string, any>;
          return klass === 'google'
            ? (c.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('')
            : (c.choices?.[0]?.delta?.content ?? '');
        }).join('');
        expect(text.toLowerCase()).toContain('pong');
      });

      (error ? it : it.skip)('records an error body carrying a diagnosable message', () => {
        const json = JSON.parse(error!.body) as { error?: { message?: string; code?: unknown } };
        expect(error!.status).toBeGreaterThanOrEqual(400);
        expect(json.error).toBeDefined();
        // A message is what surfaces to the user when a provider rejects a call.
        expect(String(json.error?.message ?? '')).not.toBe('');
      });

      it('records which endpoint produced the fixture', () => {
        const any = nonStreaming ?? streaming ?? error;
        if (!any) return; // nothing captured for this class yet
        expect(any.via).toBeTruthy();
        expect(any.transportClass).toBe(klass);
        expect(Date.parse(any.capturedAt)).not.toBeNaN();
      });
    });
  }

  it('never stores a failed request as a success fixture', () => {
    for (const klass of CLASSES) {
      for (const kind of ['nonstreaming', 'streaming']) {
        const fixture = loadFixture(`${klass}.${kind}`);
        if (fixture) expect(fixture.status).toBe(200);
      }
    }
  });

  it('stores error fixtures only for responses that actually failed', () => {
    for (const klass of CLASSES) {
      const fixture = loadFixture(`${klass}.error`);
      if (fixture) expect(fixture.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('keeps no API keys in any fixture body', () => {
    for (const file of fs.existsSync(FIXTURE_DIR) ? fs.readdirSync(FIXTURE_DIR) : []) {
      if (!file.endsWith('.json')) continue;
      const raw = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      expect(raw).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}/);
      expect(raw).not.toMatch(/\bAIza[A-Za-z0-9_-]{20,}/);
    }
  });
});
