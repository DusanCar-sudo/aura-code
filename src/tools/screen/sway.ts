/**
 * Minimal computer-use backend for sway / wlroots: grim, swaymsg and wtype.
 *
 * Same surface as ScreenSidecar (start/send/stop/killNow/running) so computer.ts
 * treats the two alike. No portal, no uinput device, no Python. The pointer is
 * moved with sway's own `seat cursor`, so coordinates are layout coordinates and
 * any output arrangement works; the capture records its output's origin and
 * adds it back on the way in. There is no accessibility tree on this path.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SidecarReply } from './sidecar.js';

const run = promisify(execFile);

const MODS: Record<string, string> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', super: 'logo', meta: 'logo', win: 'logo', logo: 'logo',
};
const NAMED: Record<string, string> = {
  enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'space',
  backspace: 'BackSpace', delete: 'Delete', del: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down', insert: 'Insert',
};
/** sway maps button4-7 to wheel up, down, left, right. */
const WHEEL = { up: 'button4', down: 'button5', left: 'button6', right: 'button7' };
const BUTTON = { left: 'BTN_LEFT', right: 'BTN_RIGHT' } as const;

export function swayBackendAvailable(): boolean {
  return !!process.env.SWAYSOCK && !!process.env.WAYLAND_DISPLAY && process.env.AURA_SCREEN_BACKEND !== 'sidecar';
}

interface Rect { x: number; y: number; width: number; height: number }

export class SwaySession {
  width = 0;
  height = 0;
  private origin = { x: 0, y: 0 };
  private started = false;

  get running(): boolean { return this.started; }

  async start(): Promise<void> {
    const out = await this.focusedOutput();
    this.width = out.width; this.height = out.height;
    this.started = true;
  }

  async stop(): Promise<void> { this.started = false; }
  killNow(): void { this.started = false; }

  async send(req: Record<string, unknown>): Promise<SidecarReply> {
    try {
      switch (req.cmd) {
        case 'capture': return await this.capture(String(req.path), Number(req.max_pixels) || 1_100_000);
        case 'accessibility_tree': return { ok: false, error: 'no accessibility tree on the sway backend; use screenshots (AURA_SCREEN_BACKEND=sidecar for AT-SPI)' };
        case 'move': await this.sway(this.at(req)); return { ok: true };
        case 'click': {
          const btn = BUTTON[req.button === 'right' ? 'right' : 'left'];
          const press = `seat - cursor press ${btn}; seat - cursor release ${btn}`;
          const n = Number(req.count) || 1;
          await this.sway(`${this.at(req)}; ${Array(n).fill(press).join('; ')}`);
          return { ok: true };
        }
        case 'drag': {
          const from = this.at({ x: req.x1, y: req.y1 }), to = this.at({ x: req.x2, y: req.y2 });
          await this.sway(`${from}; seat - cursor press BTN_LEFT; ${to}; seat - cursor release BTN_LEFT`);
          return { ok: true };
        }
        case 'scroll': {
          const dy = Number(req.dy) || 0, dx = Number(req.dx) || 0;
          const steps = [
            ...Array(Math.abs(dy)).fill(dy > 0 ? WHEEL.up : WHEEL.down),
            ...Array(Math.abs(dx)).fill(dx > 0 ? WHEEL.right : WHEEL.left),
          ].map(b => `seat - cursor press ${b}; seat - cursor release ${b}`);
          await this.sway(steps.join('; '));
          return { ok: true };
        }
        case 'type': await run('wtype', ['--', String(req.text)]); return { ok: true };
        case 'key': await run('wtype', keyArgs(String(req.combo))); return { ok: true };
        case 'close': this.started = false; return { ok: true };
        default: return { ok: false, error: `unknown command ${String(req.cmd)}` };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Point relative to the captured output → sway layout command. */
  private at(p: Record<string, unknown>): string {
    const x = Math.round(Number(p.x) + this.origin.x), y = Math.round(Number(p.y) + this.origin.y);
    return `seat - cursor set ${x} ${y}`;
  }

  private async sway(cmd: string): Promise<void> {
    const { stdout } = await run('swaymsg', ['-r', cmd]);
    const bad = (JSON.parse(stdout) as Array<{ success: boolean; error?: string }>).find(r => !r.success);
    if (bad) throw new Error(`swaymsg: ${bad.error ?? 'command failed'}`);
  }

  private async focusedOutput(): Promise<Rect & { name: string }> {
    const { stdout } = await run('swaymsg', ['-t', 'get_outputs', '-r']);
    const outs = (JSON.parse(stdout) as Array<{ name: string; focused: boolean; active: boolean; rect: Rect }>)
      .filter(o => o.active);
    const o = outs.find(x => x.focused) ?? outs[0];
    if (!o) throw new Error('sway reports no active output');
    return { name: o.name, ...o.rect };
  }

  private async capture(path: string, maxPixels: number): Promise<SidecarReply> {
    const out = await this.focusedOutput();
    this.origin = { x: out.x, y: out.y };
    this.width = out.width; this.height = out.height;
    const scale = Math.min(1, Math.sqrt(maxPixels / (out.width * out.height)));
    await run('grim', ['-o', out.name, '-s', String(scale), path]);
    return {
      ok: true, path,
      source_width: out.width, source_height: out.height,
      width: Math.floor(out.width * scale), height: Math.floor(out.height * scale),
    };
  }
}

/** "ctrl+shift+t" → wtype -M ctrl -M shift t -m shift -m ctrl */
export function keyArgs(combo: string): string[] {
  const parts = combo.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) throw new Error('empty key combo');
  const final = parts.pop()!;
  const mods = parts.map(m => {
    if (!MODS[m]) throw new Error(`unknown modifier: ${m}`);
    return MODS[m];
  });
  const named = NAMED[final] ?? (/^f([1-9]|1[0-2])$/.test(final) ? final.toUpperCase() : null);
  if (!named && final.length !== 1) throw new Error(`unknown key: ${final}`);
  return [
    ...mods.flatMap(m => ['-M', m]),
    ...(named ? ['-k', named] : [final]),
    ...[...mods].reverse().flatMap(m => ['-m', m]),
  ];
}
