import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import OpenAI from 'openai';

const SAMPLE_RATE = 16000;
const MIMO_BASE = 'https://api.xiaomimimo.com/v1';

const MIMO_VOICES: Record<string, { gender: string; lang: string }> = {
  mimo_default: { gender: 'auto', lang: 'auto' },
  "\u51b0\u7cd6":   { gender: 'female', lang: 'zh' },
  "\u8309\u8389":   { gender: 'female', lang: 'zh' },
  "\u82cf\u6253":   { gender: 'male',   lang: 'zh' },
  "\u767d\u6866":   { gender: 'male',   lang: 'zh' },
  Mia:    { gender: 'female', lang: 'en' },
  Chloe:  { gender: 'female', lang: 'en' },
  Milo:   { gender: 'male',   lang: 'en' },
  Dean:   { gender: 'male',   lang: 'en' },
};

// Ordered list of available providers. Tried in order; on auth failure, falls to next.
interface ApiProvider { key: string; baseURL: string; name: string }

function listProviders(): ApiProvider[] {
  const providers: ApiProvider[] = [];
  // Local Parakeet (NVIDIA) — highest priority when explicitly configured
  if (process.env.PARAKEET_BASE_URL) {
    const key = process.env.PARAKEET_API_KEY || 'sk-local';
    providers.push({ key, baseURL: process.env.PARAKEET_BASE_URL, name: 'Parakeet' });
  }
  // GLM-ASR (Z.ai) — next-gen real-time ASR, OpenAI-compatible /audio/transcriptions.
  // OPT-IN via DIC_USE_GLM_ASR=1: it currently needs a Z.ai audio balance
  // package (err 1113) and the plain OpenAI SDK can hang against api.z.ai, so
  // it's off the default path until the account is funded. When enabled it's
  // tried first and falls through to MiMo on any failure.
  if (process.env.ZHIPU_API_KEY && process.env.DIC_USE_GLM_ASR === '1') {
    providers.push({
      key: process.env.ZHIPU_API_KEY,
      baseURL: process.env.ZHIPU_BASE_URL || 'https://api.z.ai/api/paas/v4',
      name: 'GLM-ASR',
    });
  }
  if (process.env.XIAOMI_API_KEY) {
    const key = process.env.XIAOMI_API_KEY;
    const baseURL = key.startsWith('tp-')
      ? (process.env.XIAOMI_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1')
      : MIMO_BASE;
    providers.push({ key, baseURL, name: 'Xiaomi MiMo' });
  }
  if (process.env.OPENAI_API_KEY) {
    providers.push({ key: process.env.OPENAI_API_KEY, baseURL: 'https://api.openai.com/v1', name: 'OpenAI' });
  }
  if (process.env.GROQ_API_KEY) {
    providers.push({ key: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1', name: 'Groq' });
  }
  return providers;
}

function buildClient(api: { key: string; baseURL: string }): OpenAI {
  return new OpenAI({
    apiKey: api.key,
    baseURL: api.baseURL,
    // Bounded so a hung provider eventually falls through, but generous enough
    // for TTS (audio generation is slower than a chat/transcription call).
    timeout: 60_000,
    maxRetries: 0,
    // api.z.ai silently drops requests that arrive without a User-Agent
    // (see the zai-edge memory) — always send one.
    defaultHeaders: { 'User-Agent': 'aura-dic/1.0' },
  });
}

function cleanup(tmpDir: string): void {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// ─── Clipboard injection ──────────────────────────────────────────────────

/** Best-effort clipboard copy (wl-copy on Wayland, xclip/xsel on X11). */
async function copyToClipboard(text: string): Promise<void> {
  const candidates: string[][] = process.env.WAYLAND_DISPLAY
    ? [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']]
    : [['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input'], ['wl-copy']];
  for (const [cmd, ...args] of candidates) {
    try {
      execSync('which ' + cmd, { stdio: 'pipe' });
      // stdout/stderr must be 'ignore': wl-copy (and xclip) fork a daemon to
      // serve the clipboard, which inherits the pipes — 'close' then never
      // fires. Wait on 'exit' (the parent's) instead.
      const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      proc.stdin.write(text);
      proc.stdin.end();
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(cmd + ' timed out')), 5000);
        proc.on('exit', () => { clearTimeout(t); resolve(); });
        proc.on('error', (e) => { clearTimeout(t); reject(e); });
      });
      return;
    } catch { /* try next */ }
  }
  throw new Error('No clipboard tool found (install wl-clipboard, xclip, or xsel)');
}

export interface InjectOptions {
  /** After typing the text, press Enter (submit the prompt / line). */
  submit?: boolean;
}

/** Press the Enter key in the focused window (Wayland: ydotool; X11: xdotool). */
function pressEnter(isWayland: boolean): void {
  if (isWayland) {
    try {
      execSync('which ydotool', { stdio: 'pipe' });
      // ydotool key: <keycode>:<1=down|0=up>. 28 = KEY_ENTER (Linux evdev).
      execSync('ydotool key 28:1 28:0', { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
      return;
    } catch { /* fall through */ }
  }
  try {
    execSync('which xdotool', { stdio: 'pipe' });
    execSync('xdotool key --clearmodifiers Return', { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
  } catch { /* Enter is best-effort — the text is already typed */ }
}

/**
 * Copy text to clipboard AND type it into the focused window.
 * Types the characters directly (wtype on Wayland, xdotool type on X11)
 * instead of simulating Ctrl+V — terminals treat Ctrl+V as a literal
 * character, not paste, so a paste keystroke never lands in a CLI prompt.
 * With { submit: true }, presses Enter afterward to send the prompt.
 */
export async function injectText(text: string, opts: InjectOptions = {}): Promise<void> {
  try { await copyToClipboard(text); } catch { /* typing is the main path */ }

  // Newlines would submit a prompt / run a shell line mid-text — flatten them.
  const typed = text.replace(/\s*\n\s*/g, ' ').trim();
  if (!typed) return;

  const isWayland = !!process.env.WAYLAND_DISPLAY;
  if (isWayland) {
    let injected = false;
    try {
      execSync('which wtype', { stdio: 'pipe' });
      await new Promise(r => setTimeout(r, 150));
      // "wtype -" reads the text from stdin — no shell-quoting pitfalls.
      execSync('wtype -', { input: typed, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
      injected = true;
    } catch { /* KWin rejects the virtual-keyboard protocol — try ydotool */ }

    // ydotool types via kernel uinput — works on any Wayland compositor,
    // but needs the ydotoold daemon and /dev/uinput access.
    if (!injected) {
      try {
        execSync('which ydotool', { stdio: 'pipe' });
        await new Promise(r => setTimeout(r, 150));
        execSync('ydotool type --file -', { input: typed, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
        injected = true;
      } catch { /* fall through to error below */ }
    }

    if (!injected) {
      // Don't fall back to xdotool here: on Wayland it "types" only into
      // XWayland windows, so it reports success while a native terminal
      // (Konsole, kitty…) receives nothing — a silent failure.
      throw new Error('no working Wayland injector — this compositor rejects wtype; install ydotool + ydotoold');
    }
    if (opts.submit) pressEnter(true);
    return;
  }

  try {
    execSync('which xdotool', { stdio: 'pipe' });
    await new Promise(r => setTimeout(r, 150));
    execSync('xdotool type --clearmodifiers --file -', { input: typed, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
    if (opts.submit) pressEnter(false);
  } catch {
    throw new Error('Cannot inject text: install xdotool (X11)');
  }
}

// ─── Audio level helper ────────────────────────────────────────────────────

function rmsLevel(pcmBuffer: Buffer): number {
  if (pcmBuffer.length < 2) return 0;
  let sum = 0;
  const samples = pcmBuffer.length / 2;
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const val = pcmBuffer.readInt16LE(i);
    sum += val * val;
  }
  return Math.sqrt(sum / samples);
}

function pickPlayer(): string {
  for (const p of ['aplay', 'paplay', 'ffplay']) {
    try { execSync('which ' + p, { stdio: 'pipe' }); return p; } catch {}
  }
  return 'aplay';
}

function playWav(wavBuffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const player = pickPlayer();
    const proc = spawn(player, [], { stdio: ['pipe', 'inherit', 'inherit'] });
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('Player exited with code ' + code)));
    proc.stdin.write(wavBuffer);
    proc.stdin.end();
  });
}
// ─── Audio device listing ─────────────────────────────────────────────────

export function listDevices(): void {
  console.log(chalk.hex('#cc785c').bold('\n  Available Audio Input Devices\n'));
  try {
    const output = execSync('pactl list sources short', { stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
    const lines = output.trim().split('\n');
    if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) {
      console.log(chalk.hex('#ede0cc')('  No audio input devices found.\n'));
      return;
    }
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const id = parts[1]; // source name
      const state = parts[7] || '';
      const icon = state === 'RUNNING' ? '🎤 ' : '   ';
      console.log(`  ${icon}${chalk.hex('#ede0cc')(id)}`);
    }
    console.log(chalk.hex('#8a7768')('\n  Use:  dic --device <name>\n'));
  } catch {
    console.log(chalk.hex('#cc9e5c')('  Could not list devices (pactl not available).\n'));
  }
}

export function getDefaultDevice(): string {
  try {
    const output = execSync(
      'pactl get-default-source 2>/dev/null || pw-record --list-targets 2>/dev/null | head -1',
      { stdio: 'pipe', encoding: 'utf8', timeout: 5000 },
    );
    return output.trim();
  } catch {
    return '';
  }
}

function pickRecorder(deviceId?: string): { cmd: string; args: string[] } | null {
  // Prefer PipeWire's pw-record (handles BT, USB headsets correctly)
  try {
    execSync('which pw-record', { stdio: 'pipe' });
    const args = ['--rate=' + String(SAMPLE_RATE), '--format=s16', '--channels=1'];
    if (deviceId) {
      args.push('--target=' + deviceId);
    }
    return { cmd: 'pw-record', args };
  } catch {}

  // Fallback 1: PulseAudio's parec + ffmpeg conversion
  try {
    execSync('which parec', { stdio: 'pipe' });
    const args = ['--rate=' + String(SAMPLE_RATE), '--format=s16le', '--channels=1', '--raw'];
    if (deviceId) {
      args.push('--device=' + deviceId);
    }
    return { cmd: 'parec', args };
  } catch {}

  // Fallback 2: ALSA arecord
  try {
    execSync('which arecord', { stdio: 'pipe' });
    const args = ['-r', String(SAMPLE_RATE), '-f', 'S16_LE', '-c', '1', '-t', 'wav'];
    if (deviceId) {
      args.push('-D', deviceId);
    }
    return { cmd: 'arecord', args };
  } catch {}

  return null;
}

/**
 * Try to transcribe with one provider. Returns the transcribed text.
 * Throws on failure; caller should catch and try next provider.
 */
async function transcribeWith(api: ApiProvider, wavPath: string, printName: boolean): Promise<string> {
  const client = buildClient(api);
  if (printName) {
    const sizeKb = (fs.statSync(wavPath).size / 1024).toFixed(1);
    console.log(chalk.hex('#8a7768')('\n  Audio: ' + sizeKb + ' KB  (' + api.name + ')'));
    console.log(chalk.hex('#cc785c')('  Transcribing\u2026\n'));
  }

  if (api.name === 'Xiaomi MiMo') {
    // MiMo ASR takes inline base64 — cap it so a runaway recording doesn't
    // blow the request (25 MB wav ≈ 13 min at 16 kHz mono, ~33 MB base64).
    const audioBytes = fs.statSync(wavPath).size;
    const MAX_AUDIO_BYTES = 25_000_000;
    if (audioBytes > MAX_AUDIO_BYTES) {
      throw new Error(
        `Recording too large for inline ASR (${(audioBytes / 1e6).toFixed(1)} MB > ${MAX_AUDIO_BYTES / 1e6} MB). ` +
        'Record shorter segments or use "dic loop" for continuous dictation.',
      );
    }
    const audioBase64 = fs.readFileSync(wavPath).toString('base64');
    const response = await (client.chat.completions.create as any)({
      model: 'mimo-v2.5-asr',
      messages: [{
        role: 'user',
        content: [{
          type: 'input_audio',
          input_audio: { data: 'data:audio/wav;base64,' + audioBase64 },
        }],
      }],
      asr_options: { language: 'auto' },
    });
    return (response.choices[0]?.message?.content ?? '').trim();
  }

  const model = api.name === 'Groq' ? 'whisper-large-v3-turbo'
    : api.name === 'Parakeet' ? 'parakeet-tdt-0.6b'
    : api.name === 'GLM-ASR' ? 'glm-asr-2512'
    : 'whisper-1';
  // GLM-ASR caps at 30s / 25 MB per Z.ai docs; guard so we fail fast (and
  // fall through to MiMo) rather than sending an over-long clip.
  if (api.name === 'GLM-ASR') {
    const bytes = fs.statSync(wavPath).size;
    if (bytes > 25_000_000) throw new Error('GLM-ASR: audio > 25 MB');
  }
  const transcription = await client.audio.transcriptions.create({
    file: fs.createReadStream(wavPath),
    model,
    response_format: 'text',
  });
  const text = typeof transcription === 'string'
    ? transcription
    : (transcription as any).text ?? String(transcription);
  return text.trim();
}

/**
 * Should we fall through to the next STT provider on this error?
 *
 * A fallback chain should be forgiving: auth failures (401), balance/resource
 * errors (Z.ai 1113), rate limits (429), and network/connection blips all mean
 * "this provider couldn't serve it — try the next one". The ONLY thing that
 * should abort the whole chain is a fatal input problem (audio too large),
 * which we mark explicitly so it isn't retried pointlessly against every
 * provider.
 */
function shouldFallThrough(err: any): boolean {
  const msg = String(err?.message ?? err ?? '');
  if (/audio > 25 MB|too large/i.test(msg)) return false; // fatal input — don't retry
  if (err?.status === 401 || err?.status === 403 || err?.status === 429) return true;
  return /401|403|429|Invalid API Key|1113|Insufficient balance|no resource package|Connection error| ETIMEDOUT|ECONNRESET|ENOTFOUND|network|timeout|fetch failed/i.test(msg);
}

// ─── STT: record mic + transcribe ────────────────────────────────────────

export interface DictateOptions {
  deviceId?: string;
  inject?: boolean;
}

export async function dictate(opts: DictateOptions = {}): Promise<void> {
  const deviceId = opts.deviceId;
  const inject = opts.inject ?? false;
  const providers = listProviders();
  if (providers.length === 0) {
    console.error(chalk.hex('#b15439')(
      '\n  No API key found. Set one of:\n' +
      '    PARAKEET_BASE_URL (local NVIDIA Parakeet, no key needed)\n' +
      '    XIAOMI_API_KEY    (recommended, MiMo ASR free tier)\n' +
      '    OPENAI_API_KEY    (Whisper)\n' +
      '    GROQ_API_KEY      (Whisper via Groq, very fast)\n',
    ));
    process.exit(1);
  }

  const recorderInfo = pickRecorder(deviceId);
  if (!recorderInfo) {
    console.error(chalk.hex('#b15439')('\n  No audio recorder found. Install pw-record, parec, or arecord.\n'));
    process.exit(1);
  }

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'dic-'));
  const wavPath = path.join(tmpDir, 'recording.wav');

  // Spawn the appropriate recorder
  let recorder: import('child_process').ChildProcess;
  let parecFfmpeg: import('child_process').ChildProcess | null = null;

  if (recorderInfo.cmd === 'parec') {
    // parec outputs raw PCM (args already have --raw) → pipe through ffmpeg to create WAV
    const ffmpeg = spawn('ffmpeg', [
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1',
      '-i', 'pipe:0', '-y', wavPath,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    recorder = spawn(recorderInfo.cmd, recorderInfo.args, {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    recorder.stdout!.pipe(ffmpeg.stdin!);
    parecFfmpeg = ffmpeg;
  } else {
    // pw-record and arecord write WAV directly
    recorder = spawn(recorderInfo.cmd, [...recorderInfo.args, wavPath], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }

  // Show device info
  const devName = deviceId || getDefaultDevice();
  console.log(chalk.hex('#5a9e6e')('\n  \uD83C\uDFA4  Recording \u2014 speak into your microphone.'));
  if (devName) console.log(chalk.hex('#8a7768')('     Device: ' + devName));
  console.log(chalk.hex('#8a7768')('     Press Ctrl+C to stop and transcribe.\n'));

  await new Promise<void>((resolve) => {
    const onSigint = () => {
      process.removeListener('SIGINT', onSigint);
      recorder.kill('SIGTERM');
      if (parecFfmpeg) parecFfmpeg.kill('SIGTERM');
      resolve();
    };
    process.on('SIGINT', onSigint);
  });

  await new Promise(r => setTimeout(r, 300));

  if (!fs.existsSync(wavPath)) {
    console.error(chalk.hex('#b15439')('\n  No audio captured.\n'));
    cleanup(tmpDir);
    process.exit(1);
  }

  const stat = fs.statSync(wavPath);
  if (stat.size < 512) {
    console.log(chalk.hex('#cc9e5c')('\n  Recording too short \u2014 nothing to transcribe.\n'));
    cleanup(tmpDir);
    return;
  }

  // Normalize audio level — boosts quiet speech for better ASR accuracy
  const normPath = path.join(tmpDir, 'normalized.wav');
  try {
    execSync(
      `ffmpeg -y -i "${wavPath}" -af "dynaudnorm=p=0.9:r=0.5" -ar ${SAMPLE_RATE} -ac 1 "${normPath}" 2>/dev/null`,
      { stdio: 'pipe', timeout: 10000 },
    );
    fs.renameSync(normPath, wavPath);
  } catch {
    try { fs.unlinkSync(normPath); } catch {}
  }

  // Try each provider in order, falling through on auth errors
  let text = '';
  for (let i = 0; i < providers.length; i++) {
    const api = providers[i];
    try {
      text = await transcribeWith(api, wavPath, i === 0);
      break; // success
    } catch (err: any) {
      if (shouldFallThrough(err) && i < providers.length - 1) {
        console.log(chalk.hex('#cc9e5c')('  ' + api.name + ': unavailable (key/balance), trying next provider...\n'));
        continue;
      }
      // Last provider failed or non-recoverable error — bail out
      console.error(chalk.hex('#b15439')('\n  Transcription failed (' + api.name + '):'), String(err), '\n');
      cleanup(tmpDir);
      process.exit(1);
    }
  }

  const cleaned = text.trim();
  if (cleaned) {
    console.log(chalk.hex('#5a9e6e').bold('  \u2500\u2500 Transcription \u2500\u2500'));
    console.log(chalk.hex('#ede0cc')('  ' + cleaned));
    console.log(chalk.hex('#5a9e6e').bold('  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n'));

    let onClipboard = false;
    try {
      const clipboardModule = await import('./clipboard.js');
      await clipboardModule.clipboardTool({ action: 'copy', text: cleaned });
      onClipboard = true;
    } catch { /* injection below still works without clipboard */ }

    if (inject) {
      try {
        await injectText(cleaned);
        console.log(chalk.hex('#8a7768')('  ⌨️  Typed into focused window' + (onClipboard ? ' (also on clipboard).\n' : '.\n')));
      } catch (err) {
        console.log(chalk.hex('#cc9e5c')(
          '  ⌨️  Injection failed (' + String(err) + ')' +
          (onClipboard ? ' — text is on the clipboard, paste manually.\n' : '.\n'),
        ));
      }
    } else if (onClipboard) {
      console.log(chalk.hex('#8a7768')('  📋  Copied to clipboard.\n'));
    } else {
      console.log(chalk.hex('#cc9e5c')('  Could not copy to clipboard — text shown above only.\n'));
    }
  } else {
    // Save failed recording for debugging
    const saveDir = path.join(os.homedir(), '.aura', 'recordings');
    const saveName = 'dic_' + new Date().toISOString().replace(/[:.]/g, '-') + '.wav';
    const savePath = path.join(saveDir, saveName);
    try {
      fs.mkdirSync(saveDir, { recursive: true });
      if (fs.existsSync(wavPath)) fs.copyFileSync(wavPath, savePath);
    } catch {}
    cleanup(tmpDir);
    if (fs.existsSync(savePath)) {
      console.log(chalk.hex('#cc9e5c')('\n  No speech detected.'));
      console.log(chalk.hex('#8a7768')('  Recording saved for debugging: ' + savePath + '\n'));
    } else {
      console.log(chalk.hex('#cc9e5c')('\n  No speech detected.\n'));
    }
    return;
  }

  cleanup(tmpDir);
}

// ─── Toggle dictation (one hotkey: start → stop → transcribe → inject) ──────
//
// Designed for a global shortcut (e.g. KDE Super+Space). Press once to start
// recording; press again to stop, transcribe, and type the result — with Enter
// — into the focused window. State lives in a lock dir so the second, separate
// process can find and stop the first.

function toggleStateDir(): string {
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(base, 'dic-toggle');
}

/** Normalize a recorded wav in place and transcribe it with provider fallback. */
async function normalizeAndTranscribe(wavPath: string, providers: ApiProvider[]): Promise<string> {
  const normPath = wavPath.replace(/\.wav$/, '.norm.wav');
  try {
    execSync(
      `ffmpeg -y -i "${wavPath}" -af "dynaudnorm=p=0.9:r=0.5" -ar ${SAMPLE_RATE} -ac 1 "${normPath}" 2>/dev/null`,
      { stdio: 'pipe', timeout: 10000 },
    );
    fs.renameSync(normPath, wavPath);
  } catch {
    try { fs.unlinkSync(normPath); } catch {}
  }

  for (let i = 0; i < providers.length; i++) {
    try {
      return (await transcribeWith(providers[i], wavPath, false)).trim();
    } catch (err: any) {
      if (shouldFallThrough(err) && i < providers.length - 1) continue;
      throw err;
    }
  }
  return '';
}

function notify(title: string, body: string, replaceTag = 'dic-toggle'): void {
  try {
    execSync(
      `notify-send -a dic -h string:x-canonical-private-synchronous:${replaceTag} ` +
      `${JSON.stringify(title)} ${JSON.stringify(body)}`,
      { stdio: 'ignore', timeout: 3000 },
    );
  } catch { /* notifications are optional */ }
}

export interface ToggleOptions {
  deviceId?: string;
  /** Press Enter after typing (submit the prompt). Default true. */
  submit?: boolean;
}

/**
 * Toggle: first call starts recording (detached recorder + state files),
 * second call stops it and transcribes + injects. Returns when the whole
 * cycle (or the start half) is done.
 */
export async function toggleDictation(opts: ToggleOptions = {}): Promise<void> {
  const stateDir = toggleStateDir();
  const pidFile  = path.join(stateDir, 'recorder.pid');
  const wavFile  = path.join(stateDir, 'recording.wav');
  const rawFile  = path.join(stateDir, 'recording.raw');

  // ── STOP branch: a recording is already in progress ──────────────────────
  if (fs.existsSync(pidFile)) {
    let pid = 0;
    try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch {}
    const isParec = fs.existsSync(path.join(stateDir, 'parec'));

    // Stop the recorder; a stale pid (process already gone) is fine.
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    try { fs.unlinkSync(pidFile); } catch {}
    await new Promise(r => setTimeout(r, 400)); // let the file flush/close

    // parec path recorded raw PCM → wrap to wav.
    const srcRaw = isParec ? rawFile : wavFile;
    if (isParec && fs.existsSync(rawFile)) {
      try {
        execSync(
          `ffmpeg -y -f s16le -ar ${SAMPLE_RATE} -ac 1 -i "${rawFile}" "${wavFile}" 2>/dev/null`,
          { stdio: 'pipe', timeout: 10000 },
        );
      } catch {}
    }
    try { fs.unlinkSync(path.join(stateDir, 'parec')); } catch {}

    if (!fs.existsSync(wavFile) || fs.statSync(wavFile).size < 512) {
      notify('🎤 dic', 'Nothing recorded.');
      console.log(chalk.hex('#cc9e5c')('  Nothing recorded.\n'));
      try { fs.unlinkSync(rawFile); } catch {}
      return;
    }

    notify('🎤 dic', 'Transcribing…');
    const providers = listProviders();
    if (providers.length === 0) {
      notify('🎤 dic', 'No STT API key set.');
      console.error(chalk.hex('#b15439')('  No STT API key set.\n'));
      return;
    }

    let cleaned = '';
    try {
      cleaned = await normalizeAndTranscribe(wavFile, providers);
    } catch (err) {
      notify('🎤 dic', 'Transcription failed.');
      console.error(chalk.hex('#b15439')('  Transcription failed: ' + String(err) + '\n'));
      return;
    } finally {
      try { fs.unlinkSync(wavFile); } catch {}
      try { fs.unlinkSync(rawFile); } catch {}
    }

    if (!cleaned) {
      notify('🎤 dic', 'No speech detected.');
      console.log(chalk.hex('#cc9e5c')('  No speech detected.\n'));
      return;
    }

    console.log(chalk.hex('#ede0cc')('  ' + cleaned));
    try {
      await injectText(cleaned, { submit: opts.submit ?? true });
      notify('🎤 dic', '✓ ' + cleaned.slice(0, 80));
    } catch (err) {
      // injectText already copied to clipboard on the way in.
      notify('🎤 dic', 'Typed failed — on clipboard.');
      console.log(chalk.hex('#cc9e5c')('  Injection failed (' + String(err) + ') — text is on the clipboard.\n'));
    }
    return;
  }

  // ── START branch: no recording yet → begin one ───────────────────────────
  fs.mkdirSync(stateDir, { recursive: true });
  const recorderInfo = pickRecorder(opts.deviceId);
  if (!recorderInfo) {
    notify('🎤 dic', 'No recorder (install pw-record/arecord).');
    console.error(chalk.hex('#b15439')('  No audio recorder found.\n'));
    return;
  }

  let child: import('child_process').ChildProcess;
  if (recorderInfo.cmd === 'parec') {
    // Mark this as the raw-PCM path so STOP knows to wrap it.
    fs.writeFileSync(path.join(stateDir, 'parec'), '');
    child = spawn(recorderInfo.cmd, [...recorderInfo.args], {
      stdio: ['ignore', fs.openSync(rawFile, 'w'), 'ignore'],
      detached: true,
    });
  } else {
    child = spawn(recorderInfo.cmd, [...recorderInfo.args, wavFile], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
  }
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));

  notify('🎤 dic', 'Recording… (press again to send)');
  console.log(chalk.hex('#5a9e6e')('  🎤  Recording — press the hotkey again to stop & send.\n'));
}
// ─── TTS: text-to-speech via MiMo TTS ─────────────────────────────────────

export async function speakText(text: string, voice?: string): Promise<void> {
  const apiKey = process.env.XIAOMI_API_KEY;
  if (!apiKey) {
    console.error(chalk.hex('#b15439')(
      '\n  XIAOMI_API_KEY required for MiMo TTS.\n',
    ));
    process.exit(1);
  }

  const baseURL = apiKey.startsWith('tp-')
    ? (process.env.XIAOMI_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1')
    : MIMO_BASE;
  const client = buildClient({ key: apiKey, baseURL });
  const selectedVoice = voice || 'mimo_default';

  console.log(chalk.hex('#cc785c')('  Generating speech (voice: ' + selectedVoice + ')...\n'));

  try {
    const response = await client.chat.completions.create({
      model: 'mimo-v2.5-tts',
      messages: [
        {
          role: 'user',
          content: 'Read the following text clearly and naturally with appropriate expression.',
        },
        {
          role: 'assistant',
          content: text,
        },
      ],
      audio: { format: 'wav', voice: selectedVoice } as any,
    });

    const msg = response.choices[0]?.message as any;
    const audioData: string | undefined = msg?.audio?.data;
    if (!audioData) {
      throw new Error('No audio data in response. Message keys: ' + Object.keys(msg || {}).join(', '));
    }

    // Decode base64 and play
    const wavBuffer = Buffer.from(audioData, 'base64');
    console.log(chalk.hex('#8a7768')('  Playing... (' + (wavBuffer.length / 1024).toFixed(0) + ' KB)\n'));
    await playWav(wavBuffer);
  } catch (err) {
    console.error(chalk.hex('#b15439')('\n  TTS failed:'), String(err), '\n');
    process.exit(1);
  }
}

/**
 * Synthesize speech and return the WAV bytes (no playback, no process.exit).
 * For programmatic callers like the Telegram bot that need the audio buffer
 * to send as a voice message. Throws on failure rather than exiting.
 */
export async function synthesizeSpeech(text: string, voice?: string): Promise<Buffer> {
  const apiKey = process.env.XIAOMI_API_KEY;
  if (!apiKey) throw new Error('XIAOMI_API_KEY required for MiMo TTS');
  const baseURL = apiKey.startsWith('tp-')
    ? (process.env.XIAOMI_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1')
    : MIMO_BASE;
  const client = buildClient({ key: apiKey, baseURL });
  const response = await client.chat.completions.create({
    model: 'mimo-v2.5-tts',
    messages: [
      { role: 'user', content: 'Read the following text clearly and naturally with appropriate expression.' },
      { role: 'assistant', content: text },
    ],
    audio: { format: 'wav', voice: voice || 'mimo_default' } as any,
  });
  const audioData: string | undefined = (response.choices[0]?.message as any)?.audio?.data;
  if (!audioData) throw new Error('No audio data in TTS response');
  return Buffer.from(audioData, 'base64');
}

/**
 * Transcribe an existing audio file to text using the provider fallback chain.
 * For programmatic callers (e.g. the Telegram bot receiving a voice note).
 * Accepts any format ffmpeg can read; normalizes to 16 kHz mono wav first.
 */
export async function transcribeFile(audioPath: string): Promise<string> {
  const providers = listProviders();
  if (providers.length === 0) throw new Error('No STT provider configured (set XIAOMI_API_KEY, GROQ_API_KEY, …)');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic-tx-'));
  const wavPath = path.join(tmpDir, 'in.wav');
  try {
    execSync(
      `ffmpeg -y -i "${audioPath}" -ar ${SAMPLE_RATE} -ac 1 "${wavPath}" 2>/dev/null`,
      { stdio: 'pipe', timeout: 15000 },
    );
    return await normalizeAndTranscribe(wavPath, providers);
  } finally {
    cleanup(tmpDir);
  }
}

// ─── List available TTS voices ─────────────────────────────────────────────

export function listVoices(): void {
  console.log(chalk.hex('#cc785c').bold('\n  Xiaomi MiMo TTS Voices\n'));
  console.log(chalk.hex('#4e3d30')('  ' + 'ID'.padEnd(16) + 'Gender'.padEnd(10) + 'Language'));
  console.log(chalk.hex('#4e3d30')('  ' + '\u2500'.repeat(36)));
  for (const [id, meta] of Object.entries(MIMO_VOICES)) {
    const name = id === 'mimo_default' ? 'Auto (cluster default)' : id;
    console.log('  ' + chalk.hex('#cc785c')(id.padEnd(16)) + ' ' +
      chalk.hex('#8a7768')(meta.gender.padEnd(10)) + ' ' +
      chalk.hex('#8a7768')(meta.lang === 'zh' ? 'Chinese' : meta.lang === 'en' ? 'English' : 'Auto'));
  }
  console.log(chalk.hex('#4e3d30')('\n  Usage:  dic speak <text> --voice <id>'));
  console.log(chalk.hex('#4e3d30')('  Default: dic speak <text>\n'));
}

// ─── Continuous dictation loop ─────────────────────────────────────────────

export interface LoopOptions {
  deviceId?: string;
  silenceMs?: number;
  maxDurationMs?: number;
}

/**
 * Continuous dictation: record → transcribe → inject → repeat.
 * Stops on Ctrl+C. Uses arecord/parec with raw PCM for real-time silence detection.
 */
export async function dictationLoop(opts: LoopOptions = {}): Promise<void> {
  const providers = listProviders();
  if (providers.length === 0) {
    console.error(chalk.hex('#b15439')(
      '\n  No API key found. Set GROQ_API_KEY, OPENAI_API_KEY, or XIAOMI_API_KEY.\n',
    ));
    process.exit(1);
  }

  const deviceId = opts.deviceId;
  const silenceMs = opts.silenceMs ?? 1500;
  const maxDurationMs = opts.maxDurationMs ?? 60000;
  const devName = deviceId || getDefaultDevice();

  console.log(chalk.hex('#5a9e6e').bold('\n  🎙️  Dictation Loop — Continuous voice-to-text'));
  if (devName) console.log(chalk.hex('#8a7768')('     Device: ' + devName));
  console.log(chalk.hex('#8a7768')('     Silence threshold: ' + silenceMs + 'ms'));
  console.log(chalk.hex('#8a7768')('     Transcriptions will be injected into focused window.'));
  console.log(chalk.hex('#cc9e5c')('     Press Ctrl+C to stop.\n'));

  let running = true;
  let roundNum = 0;
  const onSigint = () => {
    running = false;
    console.log(chalk.hex('#cc9e5c')('\n  Stopping dictation loop...\n'));
  };
  process.on('SIGINT', onSigint);

  while (running) {
    roundNum++;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic-loop-'));
    const rawPath = path.join(tmpDir, 'recording.raw');
    const wavPath = path.join(tmpDir, 'recording.wav');

    try {
      // ── Record with silence detection ──────────────────────────────
      console.log(chalk.hex('#5a9e6e')('  ── Round ' + roundNum + ' ── Listening...\n'));

      const recArgs = ['-r', String(SAMPLE_RATE), '-f', 'S16_LE', '-c', '1', '-t', 'raw',
        ...(deviceId ? ['-D', deviceId] : []), rawPath];
      const recorder = spawn('arecord', recArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stopped = false;
      const silenceThreshold = 400;
      let lastSoundTime = Date.now();
      const startTime = Date.now();

      // Monitor the raw file for audio levels
      const monitor = setInterval(() => {
        if (!running || stopped) return;
        try {
          if (!fs.existsSync(rawPath)) return;
          const stat = fs.statSync(rawPath);
          if (stat.size < SAMPLE_RATE * 2) return; // need at least 1 second

          // Read last 100ms of audio for level check
          const chunkSize = SAMPLE_RATE * 2 * 0.1; // 100ms of s16le
          const readStart = Math.max(0, stat.size - chunkSize);
          const fd = fs.openSync(rawPath, 'r');
          const buf = Buffer.alloc(Math.min(chunkSize, stat.size));
          fs.readSync(fd, buf, 0, buf.length, readStart);
          fs.closeSync(fd);

          const level = rmsLevel(buf);
          if (level > silenceThreshold) {
            lastSoundTime = Date.now();
          }

          const elapsed = Date.now() - startTime;
          const silenceElapsed = Date.now() - lastSoundTime;

          if (silenceElapsed >= silenceMs && elapsed > 1000) {
            // Silence detected — stop recording
            stopped = true;
            recorder.kill('SIGTERM');
          } else if (elapsed >= maxDurationMs) {
            stopped = true;
            recorder.kill('SIGTERM');
          }
        } catch {}
      }, 200);

      await new Promise<void>((resolve) => {
        recorder.on('close', () => resolve());
        if (!running) { recorder.kill('SIGTERM'); }
      });
      clearInterval(monitor);

      if (!running) break;

      // ── Convert raw to WAV ─────────────────────────────────────────
      if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size < SAMPLE_RATE) {
        console.log(chalk.hex('#cc9e5c')('  Too short, skipping...\n'));
        cleanup(tmpDir);
        continue;
      }

      try {
        execSync(
          `ffmpeg -y -f s16le -ar ${SAMPLE_RATE} -ac 1 -i "${rawPath}" -af "dynaudnorm=p=0.9:r=0.5" "${wavPath}"`,
          { stdio: 'pipe', timeout: 10000 },
        );
      } catch {
        // Try without normalization
        try {
          execSync(
            `ffmpeg -y -f s16le -ar ${SAMPLE_RATE} -ac 1 -i "${rawPath}" "${wavPath}"`,
            { stdio: 'pipe', timeout: 10000 },
          );
        } catch {
          console.log(chalk.hex('#cc9e5c')('  Conversion failed, skipping...\n'));
          cleanup(tmpDir);
          continue;
        }
      }

      // ── Transcribe ─────────────────────────────────────────────────
      let text = '';
      for (let i = 0; i < providers.length && running; i++) {
        try {
          text = await transcribeWith(providers[i], wavPath, false);
          break;
        } catch (err: any) {
          if (shouldFallThrough(err) && i < providers.length - 1) continue;
          console.error(chalk.hex('#b15439')('  Transcribe error: ' + String(err)));
          break;
        }
      }

      const cleaned = text.trim();
      if (cleaned) {
        console.log(chalk.hex('#ede0cc')('  ' + cleaned));
        try {
          await injectText(cleaned);
          console.log(chalk.hex('#5a9e6e')('  ✓ Injected\n'));
        } catch (err) {
          // Fallback to clipboard
          try {
            const clipboardModule = await import('./clipboard.js');
            await clipboardModule.clipboardTool({ action: 'copy', text: cleaned });
            console.log(chalk.hex('#cc9e5c')('  📋 Copied to clipboard (inject failed)\n'));
          } catch {}
        }
      } else {
        console.log(chalk.hex('#cc9e5c')('  (no speech detected)\n'));
      }
    } catch (err: any) {
      if (!running) break;
      console.error(chalk.hex('#b15439')('  Error: ' + String(err)));
    }

    cleanup(tmpDir);
    if (running) await new Promise(r => setTimeout(r, 300)); // brief pause between rounds
  }

  process.removeListener('SIGINT', onSigint);
  console.log(chalk.hex('#5a9e6e').bold('  Dictation loop ended.\n'));
}
