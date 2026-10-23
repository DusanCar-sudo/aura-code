// dic-autostop — detached watcher for one-press dictation.
//
// Spawned by `dic toggle` in its START branch when auto-stop is enabled
// (opts.auto or DIC_AUTO_STOP, milliseconds). It tails the growing recording;
// when speech is followed by SILENCE_MS of quiet — or MAX_MS pass — it spawns
// `dic toggle` again, which enters the normal STOP branch (kill recorder,
// flush, silence gate, transcribe with fallback, format, deliver).
//
// Exits quietly if the recorder vanishes first (the user pressed stop and
// their own `dic toggle` owns the stop), never touching state files.
//
// Tunables: DIC_AUTO_RMS (voice floor, RMS of the trailing 100 ms; default
// 400, matching the `dic loop` silence detector).

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const stateDirArg = process.argv[2];
if (!stateDirArg) {
  console.error('usage: node dic-autostop.js <stateDir> <silenceMs>');
  process.exit(0);
}
const stateDir = stateDirArg;
const SILENCE_MS = Math.max(300, parseInt(process.argv[3] || '2000', 10) || 2000);
const MAX_MS = 45_000; // safety cap: matches `dic loop` maxDuration
const POLL_MS = 150;
// Voice floor: RMS of the trailing 100 ms. 400 is the `dic loop` threshold.
const FLOOR = Number(process.env.DIC_AUTO_RMS ?? 400) || 400;

const pidFile = path.join(stateDir, 'recorder.pid');
const wavFile = path.join(stateDir, 'recording.wav');
const rawFile = path.join(stateDir, 'recording.raw');
const argsFile = path.join(stateDir, 'watch-args.json');

// Optional breadcrumb log (stateDir/autostop.log) for tuning the watcher.
const debug = process.env.DIC_AUTOSTOP_DEBUG === '1';
function dbg(msg: string): void {
  if (!debug) return;
  try { fs.appendFileSync(path.join(stateDir, 'autostop.log'), Date.now() + ' ' + msg + '\n'); } catch {}
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** RMS of the last `bytes` of a 16-bit PCM file, or 0 when unreadable. */
function tailRms(file: string, size: number): number {
  try {
    const bytes = Math.min(3200, size); // 100 ms of 16 kHz mono s16le
    const buf = Buffer.alloc(bytes);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, bytes, size - bytes);
    fs.closeSync(fd);
    let sum = 0;
    let n = 0;
    for (let i = 0; i + 1 < bytes; i += 2) {
      const v = buf.readInt16LE(i);
      sum += v * v;
      n++;
    }
    return n ? Math.sqrt(sum / n) : 0;
  } catch {
    return 0;
  }
}

const start = Date.now();
let lastVoice = start;     // anything unsaid still counts as "could speak now"
let seenSpeech = false;

const tick = (): void => {
  // Recorder gone → the user's second press ran its own stop. Back off.
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) || 0; } catch {}
  if (!pid || !alive(pid)) process.exit(0);

  // Follow whichever file the active recorder grows (pw-record → wav, parec → raw).
  let file = '';
  let size = 0;
  for (const f of [wavFile, rawFile]) {
    try {
      const s = fs.statSync(f).size;
      if (s > 8192) { file = f; size = s; break; }
    } catch {}
  }

  if (file) {
    const rms = tailRms(file, size);
    if (rms >= FLOOR) {
      lastVoice = Date.now();
      seenSpeech = true;
    } else {
      dbg('silent rms=' + Math.round(rms) + ' trailing=' + (Date.now() - lastVoice));
    }
  }

  const trailingSilence = Date.now() - lastVoice;
  const elapsed = Date.now() - start;

  if ((seenSpeech && trailingSilence >= SILENCE_MS) || elapsed >= MAX_MS) {
    dbg('trigger seenSpeech=' + seenSpeech + ' trailing=' + trailingSilence + ' elapsed=' + elapsed);
    // Trigger the same stop path a second hotkey press would take. Forward
    // the delivery options the START press recorded.
    let flags: string[] = [];
    try {
      const a = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
      if (a.device) flags.push('--device', String(a.device));
      if (a.submit === false) flags.push('--no-submit');
      if (a.inject === false) flags.push('--clip-only');
      if (a.submit === false && a.inject === false) flags.push('--no-submit', '--clip-only');
    } catch { /* defaults are fine */ }

    const dicJs = path.join(path.dirname(process.argv[1]), 'dic.js');
    // A wrapper (aura-dic) may own delivery details around the stop — like
    // pressing Enter in non-terminal windows — so spawn it when configured;
    // otherwise the plain `dic toggle` stop path is correct by itself.
    const stopCmd = process.env.DIC_AUTO_STOP_CMD;
    if (stopCmd && fs.existsSync(stopCmd)) {
      const child = spawn(stopCmd, flags, { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const child = spawn(process.execPath, [dicJs, 'toggle', ...flags], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
    process.exit(0);
  }
};

setInterval(tick, POLL_MS);
