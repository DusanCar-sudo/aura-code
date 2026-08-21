/**
 * `computer` — see the screen and drive the pointer and keyboard.
 *
 * Shaped like browser.ts (one action enum, module-level handle) because it has
 * the same character: a stateful session that several calls share. The
 * differences from every other tool are what the design has to answer for.
 *
 * The model speaks IMAGE coordinates, always. A capture is downscaled before it
 * is sent, so screen and image coordinates differ by a factor that is invisible
 * in the numbers themselves (2.25 on the development machine). Conversion
 * happens once, in screen/coords.ts, on the way to the input device — asking
 * the model to scale its own coordinates is asking it to do arithmetic it
 * cannot check, somewhere being wrong looks like a misgrounded click.
 *
 * Every action reports what the screen looked like afterwards is NOT done here:
 * an automatic screenshot per action doubles the token cost of a run, and most
 * actions in a sequence (type, then key, then key) need no visual confirmation.
 * The model asks for a screenshot when it needs one; the system prompt tells it
 * to verify after anything it expects to change the screen.
 */

import type { ToolDefinition } from '../providers/types.js';
import type { ToolOutput } from './index.js';
import { ScreenSidecar } from './screen/sidecar.js';
import { imageToLogical, isInsideImage, geometryKey, type CaptureGeometry } from './screen/coords.js';
import { checkComputerUseGate, COMPUTER_USE_DISCLOSURE, isAcknowledged } from './screen/disclosure.js';
import { recordLesson, formatLessonsBlock } from './screen/lessons.js';
import * as os from 'os';
import * as path from 'path';

export const COMPUTER_DEFINITION: ToolDefinition = {
  name: 'computer',
  description:
    'See the screen and control the mouse and keyboard. Actions: screenshot, click, double_click, '
    + 'right_click, move, drag, type, key, scroll, remember. '
    + 'ALWAYS take a screenshot first and read coordinates off that image — x/y are in the '
    + 'coordinates of the screenshot you were shown, not the raw screen. Take another screenshot '
    + 'after anything you expect to change the screen, and check it did.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'screenshot | click | double_click | right_click | move | drag | type | key | scroll | remember' },
      x:      { type: 'number', description: 'X in screenshot coordinates' },
      y:      { type: 'number', description: 'Y in screenshot coordinates' },
      to_x:   { type: 'number', description: 'drag: destination X in screenshot coordinates' },
      to_y:   { type: 'number', description: 'drag: destination Y in screenshot coordinates' },
      text:   { type: 'string', description: 'type: the text to type' },
      combo:  { type: 'string', description: 'key: e.g. "ctrl+t", "alt+tab", "enter", "ctrl+shift+f5"' },
      dy:     { type: 'number', description: 'scroll: wheel clicks, positive = up' },
      dx:     { type: 'number', description: 'scroll: horizontal wheel clicks' },
      note:   { type: 'string', description: 'remember: one line worth keeping for next time' },
      key_id: { type: 'string', description: 'remember: stable id, so the same fact is stored once (e.g. "chrome:address-bar")' },
    },
    required: ['action'],
  },
};

export interface ComputerInput {
  action: string;
  x?: number; y?: number; to_x?: number; to_y?: number;
  text?: string; combo?: string; dy?: number; dx?: number;
  note?: string; key_id?: string;
}

let sidecar: ScreenSidecar | null = null;
/** Geometry of the most recent capture — how image coordinates are converted.
 *  Null until the first screenshot, which is why positional actions demand one. */
let lastCapture: CaptureGeometry | null = null;

/** Set by the CLI when --computer was passed. Separate from the env var on
 *  purpose; see screen/disclosure.ts for why both are required. */
let flagEnabled = false;
export function setComputerUseEnabled(on: boolean): void { flagEnabled = on; }

/** Release the child process and its uinput/portal handles. */
export async function closeComputer(): Promise<void> {
  if (sidecar) { await sidecar.stop(); sidecar = null; lastCapture = null; }
}

export async function computerTool(input: ComputerInput): Promise<ToolOutput> {
  const gate = checkComputerUseGate(flagEnabled);
  if (!gate.allowed) {
    return gate.needsDisclosure
      ? `Error: ${gate.reason}\n\n${COMPUTER_USE_DISCLOSURE}\n`
        + 'Show this to the user and ask them to confirm before retrying.'
      : `Error: ${gate.reason}`;
  }

  const action = String(input.action ?? '').toLowerCase();

  try {
    if (!sidecar) {
      sidecar = new ScreenSidecar();
      await sidecar.start();
    }

    switch (action) {
      case 'screenshot': return await screenshot(sidecar);

      case 'move': {
        const p = await point(input);
        await sidecar.send({ cmd: 'move', ...p });
        return `Moved to (${input.x}, ${input.y}).`;
      }

      case 'click': case 'double_click': case 'right_click': {
        const p = await point(input);
        const button = action === 'right_click' ? 'right' : 'left';
        const count = action === 'double_click' ? 2 : 1;
        await sidecar.send({ cmd: 'click', button, count, ...p });
        return `${label(action)} at (${input.x}, ${input.y}). `
          + 'Take a screenshot to confirm it did what you expected.';
      }

      case 'drag': {
        if (!num(input.x) || !num(input.y) || !num(input.to_x) || !num(input.to_y)) {
          return 'Error: drag needs x, y, to_x and to_y in screenshot coordinates.';
        }
        const g = requireCapture();
        const from = imageToLogical(input.x!, input.y!, g);
        const to = imageToLogical(input.to_x!, input.to_y!, g);
        await sidecar.send({ cmd: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y });
        return `Dragged (${input.x}, ${input.y}) → (${input.to_x}, ${input.to_y}).`;
      }

      case 'type': {
        if (typeof input.text !== 'string' || input.text === '') {
          return 'Error: type needs non-empty text.';
        }
        const r = await sidecar.send({ cmd: 'type', text: input.text });
        // Reported rather than dropped: a half-typed string the model cannot
        // detect is worse than a refusal, because it will carry on regardless.
        return r.unsupported
          ? `Typed, but these characters are not on the keymap and were skipped: `
            + `${String(r.unsupported)}. The typed text is therefore incomplete — `
            + 'screenshot to see what actually landed.'
          : `Typed ${input.text.length} character(s).`;
      }

      case 'key': {
        if (!input.combo) return 'Error: key needs a combo, e.g. "ctrl+t".';
        const r = await sidecar.send({ cmd: 'key', combo: input.combo });
        if (!r.ok) return `Error: ${r.error ?? 'key failed'}`;
        return `Pressed ${input.combo}.`;
      }

      case 'scroll': {
        const dy = Number(input.dy ?? 0), dx = Number(input.dx ?? 0);
        if (!dy && !dx) return 'Error: scroll needs dy and/or dx (wheel clicks).';
        if (num(input.x) && num(input.y)) {
          const p = await point(input);           // scroll where the model is looking
          await sidecar.send({ cmd: 'move', ...p });
        }
        await sidecar.send({ cmd: 'scroll', dy, dx });
        return `Scrolled dy=${dy} dx=${dx}.`;
      }

      case 'remember': {
        if (!input.note || !input.key_id) {
          return 'Error: remember needs key_id and note.';
        }
        const geo = lastCapture ? geometryKey(lastCapture) : undefined;
        const fresh = recordLesson(input.key_id, input.note, geo);
        return fresh
          ? `Remembered for next time: ${input.note}`
          : `Already known (${input.key_id}) — not stored again.`;
      }

      default:
        return `Error: unknown computer action "${input.action}". `
          + 'Use screenshot, click, double_click, right_click, move, drag, type, key, scroll or remember.';
    }
  } catch (e) {
    // A dead sidecar must not poison every later call with a stale handle.
    const msg = e instanceof Error ? e.message : String(e);
    if (sidecar && !sidecar.running) { sidecar = null; lastCapture = null; }
    return `Error: ${msg}`;
  }
}

async function screenshot(sc: ScreenSidecar): Promise<ToolOutput> {
  const out = path.join(os.tmpdir(), `aura-screen-${Date.now()}.png`);
  const r = await sc.send({ cmd: 'capture', path: out, max_pixels: 1_100_000 });
  if (!r.ok) return `Error: ${r.error ?? 'capture failed'}`;

  lastCapture = {
    sourceWidth: Number(r.source_width), sourceHeight: Number(r.source_height),
    width: Number(r.width), height: Number(r.height),
  };
  const { readFileSync } = await import('fs');
  const b64 = readFileSync(String(r.path)).toString('base64');

  const lessons = formatLessonsBlock(geometryKey(lastCapture));
  return {
    text:
      `Screenshot: ${lastCapture.width}x${lastCapture.height} `
      + `(screen is ${lastCapture.sourceWidth}x${lastCapture.sourceHeight}). `
      + 'Give x/y in the coordinates of THIS image; they are converted for you.'
      + lessons,
    images: [`data:image/png;base64,${b64}`],
  };
}

/** Convert a model-supplied point, refusing rather than guessing when there is
 *  no capture to convert against. */
async function point(input: ComputerInput): Promise<{ x: number; y: number }> {
  if (!num(input.x) || !num(input.y)) {
    throw new Error('this action needs x and y in screenshot coordinates.');
  }
  const g = requireCapture();
  if (!isInsideImage(input.x!, input.y!, g)) {
    throw new Error(
      `(${input.x}, ${input.y}) is outside the ${g.width}x${g.height} screenshot. `
      + 'Take a fresh screenshot and read the coordinates off it.',
    );
  }
  return imageToLogical(input.x!, input.y!, g);
}

function requireCapture(): CaptureGeometry {
  if (!lastCapture) {
    throw new Error(
      'no screenshot yet — take one first. Coordinates are relative to the '
      + 'screenshot you were shown, so there is nothing to convert against.',
    );
  }
  return lastCapture;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const label = (a: string) =>
  a === 'double_click' ? 'Double-clicked' : a === 'right_click' ? 'Right-clicked' : 'Clicked';

/** Exposed for tests and for :computer status output. */
export function computerState(): { started: boolean; capture: CaptureGeometry | null; acknowledged: boolean } {
  return { started: sidecar !== null, capture: lastCapture, acknowledged: isAcknowledged() };
}
