#!/usr/bin/env ts-node
/**
 * Capture real provider responses as replay fixtures.
 *
 * Four fixtures cover thirty providers because there are only four wire
 * formats — see tests/fixtures/providers/README.md for that argument.
 *
 * Usage:
 *   npm run fixtures:capture              # every class whose credentials exist
 *   npm run fixtures:capture -- anthropic # just one
 *
 * Each class is captured three ways: a non-streaming completion, a streaming
 * completion (chunks recorded in order), and one error response. Classes whose
 * credentials are absent are skipped loudly — a missing fixture must look like
 * a gap, never like a pass.
 *
 * Requests are deliberately trivial ("Reply with the single word: pong") so a
 * refresh costs a fraction of a cent and sends nothing sensitive.
 */
import * as fs from 'fs';
import * as path from 'path';

const FIXTURE_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'providers');

const PROMPT = 'Reply with the single word: pong';

interface CaptureTarget {
  /** Transport class — the thing the fixture actually proves. */
  klass: 'anthropic' | 'google' | 'openai-compatible' | 'archimedes-local';
  /** Human note recorded into the fixture, so a reader knows what produced it. */
  via: string;
  url: string;
  headers: () => Record<string, string> | undefined;
  body: (stream: boolean) => unknown;
  /** A request guaranteed to be rejected, for the error fixture. */
  errorBody: () => unknown;
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

const TARGETS: CaptureTarget[] = [
  {
    klass: 'anthropic',
    via: 'api.anthropic.com /v1/messages',
    url: 'https://api.anthropic.com/v1/messages',
    headers: () => {
      const key = env('ANTHROPIC_API_KEY');
      if (!key) return undefined;
      return {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      };
    },
    body: (stream) => ({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16,
      stream,
      messages: [{ role: 'user', content: PROMPT }],
    }),
    errorBody: () => ({
      model: 'claude-does-not-exist',
      max_tokens: 16,
      messages: [{ role: 'user', content: PROMPT }],
    }),
  },
  {
    klass: 'google',
    via: 'generativelanguage.googleapis.com v1beta generateContent',
    url: '', // filled per-call below (the verb is in the path)
    headers: () => (env('GOOGLE_API_KEY') ? { 'content-type': 'application/json' } : undefined),
    body: () => ({ contents: [{ role: 'user', parts: [{ text: PROMPT }] }] }),
    errorBody: () => ({ contents: [] }),
  },
  {
    klass: 'openai-compatible',
    via: 'api.z.ai /api/paas/v4/chat/completions (Zhipu)',
    url: 'https://api.z.ai/api/paas/v4/chat/completions',
    headers: () => {
      const key = env('ZHIPU_API_KEY');
      if (!key) return undefined;
      return { 'content-type': 'application/json', authorization: `Bearer ${key}` };
    },
    body: (stream) => ({
      model: 'glm-4.6',
      max_tokens: 16,
      stream,
      messages: [{ role: 'user', content: PROMPT }],
    }),
    errorBody: () => ({
      model: 'no-such-model',
      messages: [{ role: 'user', content: PROMPT }],
    }),
  },
  {
    klass: 'archimedes-local',
    via: 'localhost:11434 (Ollama) /v1/chat/completions',
    url: 'http://localhost:11434/v1/chat/completions',
    headers: () => ({ 'content-type': 'application/json' }),
    body: (stream) => ({
      model: env('AURA_FIXTURE_LOCAL_MODEL') ?? 'granite4.1:3b',
      max_tokens: 16,
      stream,
      messages: [{ role: 'user', content: PROMPT }],
    }),
    errorBody: () => ({
      model: 'definitely-not-installed:0b',
      messages: [{ role: 'user', content: PROMPT }],
    }),
  },
];

function googleUrl(stream: boolean): string {
  const key = env('GOOGLE_API_KEY') ?? '';
  const verb = stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?';
  return `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:${verb}key=${key}`;
}

/** Strip anything that would make a fixture a secret or a diff-churn machine. */
function redact(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '<REDACTED_JWT>')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '<REDACTED_KEY>')
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, '<REDACTED_KEY>');
}

interface Fixture {
  transportClass: string;
  via: string;
  capturedAt: string;
  status: number;
  /** Raw response body — SSE text for streaming, JSON text otherwise. */
  body: string;
}

async function capture(
  target: CaptureTarget,
  kind: 'nonstreaming' | 'streaming' | 'error',
): Promise<Fixture | undefined> {
  const headers = target.headers();
  if (!headers) return undefined; // no credentials for this class

  const stream = kind === 'streaming';
  const url = target.klass === 'google' ? googleUrl(stream) : target.url;
  const body = kind === 'error' ? target.errorBody() : target.body(stream);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    transportClass: target.klass,
    via: target.via,
    capturedAt: new Date().toISOString(),
    status: res.status,
    body: redact(text),
  };
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  const skipped: string[] = [];
  for (const target of TARGETS) {
    if (only.length > 0 && !only.includes(target.klass)) continue;
    if (!target.headers()) {
      skipped.push(target.klass);
      console.log(`SKIP  ${target.klass} — no credentials / backend unreachable`);
      continue;
    }
    for (const kind of ['nonstreaming', 'streaming', 'error'] as const) {
      try {
        const fixture = await capture(target, kind);
        if (!fixture) continue;
        // A success fixture must record a success. Storing a 402/404 under
        // `nonstreaming` would let a broken account masquerade as a captured
        // wire format — the exact thing fixtures exist to rule out.
        if (kind !== 'error' && fixture.status !== 200) {
          console.log(
            `FAIL  ${target.klass}.${kind}: HTTP ${fixture.status} is not a usable capture`
            + ` — ${fixture.body.slice(0, 160).replace(/\s+/g, ' ')}`,
          );
          continue;
        }
        if (kind === 'error' && fixture.status < 400) {
          console.log(`FAIL  ${target.klass}.error: expected a 4xx/5xx, got ${fixture.status}`);
          continue;
        }
        const file = path.join(FIXTURE_DIR, `${target.klass}.${kind}.json`);
        fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
        console.log(`OK    ${target.klass}.${kind} (HTTP ${fixture.status}) -> ${path.relative(process.cwd(), file)}`);
      } catch (e) {
        console.log(`FAIL  ${target.klass}.${kind}: ${String(e)}`);
      }
    }
  }

  if (skipped.length > 0) {
    console.log(
      `\n${skipped.length} class(es) not captured: ${skipped.join(', ')}.`
      + '\nTheir replay tests will skip until credentials exist — a missing fixture'
      + '\nis a visible gap, not a silent pass.',
    );
  }
}

void main();
