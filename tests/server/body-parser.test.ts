import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { jsonBodyParser } from '../../src/server/index.js';

/**
 * The attach route carries base64 screenshots and mounts its own 25mb JSON
 * parser. The global parser used to run first with express.json()'s default
 * 100kb cap, so every screenshot upload died as a 413 before the route's
 * limit was ever consulted — the file never reached the task, and the agent
 * ran without the attachment the user had just picked. These pin the ordering
 * against a real HTTP round-trip, because nothing short of that sees it.
 */

const servers: http.Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function post(url: string, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${url}${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('jsonBodyParser', () => {
  it('lets a screenshot-sized body reach the attach route, not a 413', async () => {
    const app = express();
    app.use(jsonBodyParser());
    // The route's own parser, exactly as the real one is mounted.
    app.post('/api/board/attach', express.json({ limit: '25mb' }), (_req, res) => {
      res.json({ ok: true });
    });
    const url = await listen(app);

    // ~300kb of base64 — three times the default cap, a small screenshot.
    const payload = JSON.stringify({
      taskId: 't1', name: 'shot.png', type: 'image/png',
      dataUrl: `data:image/png;base64,${'A'.repeat(300 * 1024)}`,
    });
    const res = await post(url, '/api/board/attach', payload);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('still parses ordinary JSON bodies for every other route', async () => {
    const app = express();
    app.use(jsonBodyParser());
    app.post('/api/memo', (req, res) => {
      res.json({ got: (req.body as { text?: string }).text });
    });
    const url = await listen(app);

    const res = await post(url, '/api/memo', JSON.stringify({ text: 'hello' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ got: 'hello' });
  });

  it('still enforces the 100kb cap on routes that did not raise it', async () => {
    const app = express();
    app.use(jsonBodyParser());
    app.post('/api/memo', (_req, res) => { res.json({ ok: true }); });
    const url = await listen(app);

    const res = await post(url, '/api/memo', JSON.stringify({ text: 'A'.repeat(150 * 1024) }));
    expect(res.status).toBe(413);
  });
});
