import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import * as http from 'http';
import { jsonBodyParser } from '../../src/server/index.js';

/**
 * A body-size fault that unit tests cannot see.
 *
 * /api/board/attach mounts its own 25mb parser, which looks correct in
 * isolation — but a global `app.use(express.json())` runs first, and with its
 * 100kb default it rejects the body as a 413 before the route's limit is ever
 * consulted. The upload then fails for any real screenshot while working
 * perfectly for the tiny file you tested with.
 *
 * So this stands up a real Express app and posts a body bigger than the
 * default cap through the actual middleware chain. Nothing short of that
 * catches an ordering bug between two middlewares.
 */

const servers: http.Server[] = [];

afterAll(() => { for (const s of servers) s.close(); });

async function appWithParser(): Promise<string> {
  const app = express();
  app.use(jsonBodyParser());
  // Mirrors the real routes: the attach path brings its own larger parser.
  app.post('/api/board/attach', express.json({ limit: '25mb' }), (req, res) => {
    res.json({ ok: true, got: (req.body as { blob?: string }).blob?.length ?? 0 });
  });
  app.post('/api/apikey', (req, res) => {
    res.json({ ok: true, got: (req.body as { blob?: string }).blob?.length ?? 0 });
  });

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

/** A JSON body comfortably past express.json()'s 100kb default. */
const bigBody = JSON.stringify({ blob: 'A'.repeat(300_000) });

const post = (base: string, path: string) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: bigBody,
});

describe('body size limits', () => {
  it('lets an attachment past the global 100kb cap', async () => {
    const base = await appWithParser();
    const res = await post(base, '/api/board/attach');
    expect(res.status).toBe(200);
    expect((await res.json()).got).toBe(300_000);
  });

  it('still caps every other route', async () => {
    // The exception has to be narrow. A global 25mb limit would let any
    // endpoint take 25mb of JSON, which is a much larger promise than "you can
    // attach a screenshot".
    const base = await appWithParser();
    expect((await post(base, '/api/apikey')).status).toBe(413);
  });
});
