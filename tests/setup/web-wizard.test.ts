import { describe, it, expect, afterAll } from 'vitest';
import { runWebWizard } from '../../src/setup/web-wizard.js';

// The web wizard is what the desktop installers launch as their final step, and
// its page holds an API key in a form field. These tests pin the auth gates:
// the token is deliberately unguessable from outside the process, so what is
// verifiable here — and what actually matters — is that everything without it
// is refused.

const PORT = 7399;
const BASE = `http://127.0.0.1:${PORT}`;

// runWebWizard resolves only once the user finishes or skips, so hold the
// promise to keep the listener up, then skip in afterAll to close it.
const wizard = runWebWizard({ port: PORT, open: false });

describe('web setup wizard auth', () => {
  afterAll(() => {
    // Nothing here can reach /api/skip — the token gate refuses us, which is
    // precisely what these tests assert. Detach instead: vitest tears the
    // worker down, and an unresolved promise must not wedge the run.
    wizard.catch(() => null);
  });

  it('refuses the provider catalogue without a token', async () => {
    const res = await fetch(`${BASE}/api/providers`);
    expect(res.status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const res = await fetch(`${BASE}/api/providers`, {
      headers: { 'X-Aura-Token': 'not-the-token' },
    });
    expect(res.status).toBe(401);
  });

  it('refuses a save attempt from a foreign origin', async () => {
    const res = await fetch(`${BASE}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil.example' },
      body: JSON.stringify({ provider: 'DeepSeek', model: 'deepseek-v4-flash' }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it('refuses the page itself without a token', async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(401);
  });
});
