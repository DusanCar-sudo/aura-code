import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { computerTool, setComputerUseEnabled, COMPUTER_DEFINITION } from '../../src/tools/computer.js';
import { acknowledge, COMPUTER_USE_ENV } from '../../src/tools/screen/disclosure.js';
import { TOOL_DEFINITIONS } from '../../src/tools/index.js';

/**
 * These never start the sidecar. Every case here is a refusal that must happen
 * *before* a child process, a portal handshake and a uinput device get created
 * — which is the point: the expensive, physical part of this tool must be
 * unreachable until the gate and the coordinate contract are both satisfied.
 */

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-computer-'));
  vi.stubEnv('AURA_HOME', home);
  setComputerUseEnabled(false);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  setComputerUseEnabled(false);
});

const text = (r: unknown) => typeof r === 'string' ? r : (r as { text: string }).text;

describe('the gate stands in front of everything', () => {
  it('refuses with neither flag nor env var, without starting anything', async () => {
    const r = await computerTool({ action: 'screenshot' });
    expect(text(r)).toMatch(/Error/);
    expect(text(r)).toMatch(/--computer/);
  });

  it('refuses with the env var but no flag', async () => {
    vi.stubEnv(COMPUTER_USE_ENV, '1');
    expect(text(await computerTool({ action: 'screenshot' }))).toMatch(/Error/);
  });

  it('shows the disclosure, not a bare refusal, when it is merely unacknowledged', async () => {
    // The user cannot accept something they were never shown.
    vi.stubEnv(COMPUTER_USE_ENV, '1');
    setComputerUseEnabled(true);
    const r = text(await computerTool({ action: 'screenshot' }));
    expect(r).toMatch(/whole screen/i);
    expect(r).toMatch(/no sandbox/i);
    expect(r).toMatch(/ask them to confirm/i);
  });
});

describe('the coordinate contract', () => {
  beforeEach(() => { vi.stubEnv(COMPUTER_USE_ENV, '1'); setComputerUseEnabled(true); acknowledge(); });

  it('refuses a click before any screenshot exists', async () => {
    // x/y are relative to an image the model was shown. With no capture there
    // is nothing to convert against, and guessing would click the wrong place.
    const r = text(await computerTool({ action: 'click', x: 10, y: 10 }));
    expect(r).toMatch(/screenshot/i);
  });

  it('refuses a positional action with no coordinates', async () => {
    expect(text(await computerTool({ action: 'click' }))).toMatch(/x and y/i);
  });

  it('rejects an unknown action and lists the real ones', async () => {
    const r = text(await computerTool({ action: 'teleport' }));
    expect(r).toMatch(/unknown computer action/i);
    expect(r).toMatch(/screenshot/);
  });

  it('validates drag endpoints', async () => {
    expect(text(await computerTool({ action: 'drag', x: 1, y: 2 }))).toMatch(/to_x/);
  });

  it('rejects empty text and a missing key combo', async () => {
    expect(text(await computerTool({ action: 'type', text: '' }))).toMatch(/non-empty/);
    expect(text(await computerTool({ action: 'key' }))).toMatch(/combo/);
  });

  it('rejects a scroll that would do nothing', async () => {
    expect(text(await computerTool({ action: 'scroll' }))).toMatch(/dy/);
  });
});

describe('remember', () => {
  beforeEach(() => { vi.stubEnv(COMPUTER_USE_ENV, '1'); setComputerUseEnabled(true); acknowledge(); });

  it('stores a first-time fact and refuses to double-store it', async () => {
    const first = text(await computerTool({ action: 'remember', key_id: 'k', note: 'taskbar is on the laptop' }));
    expect(first).toMatch(/Remembered/);
    const again = text(await computerTool({ action: 'remember', key_id: 'k', note: 'same fact' }));
    expect(again).toMatch(/Already known/);
  });

  it('needs both an id and a note', async () => {
    expect(text(await computerTool({ action: 'remember', note: 'x' }))).toMatch(/key_id/);
  });
});

describe('the tool definition', () => {
  it('is registered so the model can actually reach it', () => {
    expect(TOOL_DEFINITIONS.some(d => d.name === 'computer')).toBe(true);
  });

  it('tells the model the coordinate rule in the description', () => {
    // This is the one instruction that prevents a whole class of silent misses,
    // so it belongs where the model always sees it, not only in a good reply.
    expect(COMPUTER_DEFINITION.description).toMatch(/screenshot first/i);
    expect(COMPUTER_DEFINITION.description).toMatch(/not the raw screen/i);
  });
});
