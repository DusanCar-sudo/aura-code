import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execCalls: string[] = [];
const stdinInputs: (string | undefined)[] = [];

// child_process is captured before the module under test imports it, so every
// execSync the injector makes is recorded instead of touching a real window.
vi.mock('child_process', async () => {
  const cp = await vi.importActual<any>('child_process');
  return {
    ...cp,
    execSync: (cmd: string, opts?: any) => {
      execCalls.push(cmd);
      stdinInputs.push(opts?.input);
      return Buffer.from('');
    },
    spawn: cp.spawn,
  };
});

import { injectText } from '../src/tools/dictate.js';

const originalWayland = process.env.WAYLAND_DISPLAY;

beforeEach(() => {
  execCalls.length = 0;
  stdinInputs.length = 0;
});

afterEach(() => {
  if (originalWayland === undefined) delete process.env.WAYLAND_DISPLAY;
  else process.env.WAYLAND_DISPLAY = originalWayland;
});

describe('injectText keystroke pacing', () => {
  it('types with a non-zero delay on Wayland via wtype', async () => {
    process.env.WAYLAND_DISPLAY = 'wayland-1';
    await injectText('the quick brown fox jumps over the lazy dog');

    const wtype = execCalls.find((c) => c.startsWith('wtype'));
    expect(wtype, 'expected wtype to be used on Wayland').toBeTruthy();
    // wtype defaults to -d 0, which floods a TUI and scrambles the text.
    expect(wtype).toMatch(/-d (\d+)/);
    expect(Number(wtype!.match(/-d (\d+)/)![1])).toBeGreaterThan(0);
  });

  it('types with a non-zero delay on X11 via xdotool', async () => {
    delete process.env.WAYLAND_DISPLAY;
    await injectText('the quick brown fox jumps over the lazy dog');

    const xdotool = execCalls.find((c) => c.startsWith('xdotool type'));
    expect(xdotool, 'expected xdotool to be used on X11').toBeTruthy();
    expect(xdotool).toMatch(/--delay (\d+)/);
    expect(Number(xdotool!.match(/--delay (\d+)/)![1])).toBeGreaterThan(0);
  });

  it('flattens newlines instead of submitting mid-text', async () => {
    process.env.WAYLAND_DISPLAY = 'wayland-1';
    await injectText('first line\nsecond line\nthird line');

    const typed = stdinInputs.find((i) => i && i.includes('second line'));
    expect(typed).toBe('first line second line third line');
  });

  it('sends the transcript text itself as the injected payload', async () => {
    process.env.WAYLAND_DISPLAY = 'wayland-1';
    await injectText('I wanted to say that our mic is not doing well');

    expect(stdinInputs).toContain('I wanted to say that our mic is not doing well');
  });
});
