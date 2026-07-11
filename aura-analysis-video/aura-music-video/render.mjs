/**
 * Render the Aura music video using Puppeteer + ffmpeg.
 *
 * Usage: node render.mjs
 *
 * This script:
 *   1. Opens index.html in headless Chrome
 *   2. Captures every frame at 24fps using the __seek() controller
 *   3. Stitches frames into an MP4 via ffmpeg
 *   4. Overlays Aura.mp3 as the audio track
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FPS = 24;
const WIDTH = 1080;
const HEIGHT = 1920;
const HTML_PATH = path.join(__dirname, 'index.html');
const AURA_MP3 = path.resolve(__dirname, '../../Aura.mp3');
const OUTPUT = path.join(__dirname, 'renders', 'aura-music-video.mp4');

// ── Resolve audio duration from Aura.mp3 ──
const probe = JSON.parse(execSync(
  `ffprobe -v quiet -print_format json -show_format "${AURA_MP3}"`,
  { encoding: 'utf8' }
));
const DURATION = parseFloat(probe.format.duration); // ~179 s
const TOTAL_FRAMES = Math.ceil(DURATION * FPS);

console.log(`Audio duration: ${DURATION.toFixed(1)}s · Total frames: ${TOTAL_FRAMES}`);

// ── Chrome path ──
function findChrome() {
  const candidates = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium'];
  for (const cmd of candidates) {
    try {
      const out = execSync(`which ${cmd}`, { stdio: 'pipe' });
      return out.toString().trim();
    } catch {}
  }
  for (const p of ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome not found');
}

const CHROME = findChrome();

// ── Temp dir for frames ──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-vid-'));
const framePattern = path.join(tmpDir, 'frame-%06d.png');

console.log(`Temp frames: ${tmpDir}`);
console.log(`Output: ${OUTPUT}`);

// ── Puppeteer ──
const puppeteer = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(`file://${HTML_PATH}`, { waitUntil: 'networkidle0', timeout: 30000 });

  // Inject the __seek controller
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = '__aura-control';
    style.textContent = `.aura-el { animation-play-state: paused !important; opacity: 0; }`;
    document.head.appendChild(style);

    window.__seek = (t) => {
      document.querySelectorAll('.aura-el').forEach((el) => {
        const enter = parseFloat(el.dataset.enter || '0');
        const exit = parseFloat(el.dataset.exit || '9999');
        const dur = parseFloat(el.dataset.dur || '0.5');
        const enterAnim = el.dataset.enterAnim || 'fadeIn';
        const exitAnim = el.dataset.exitAnim || 'fadeOut';

        if (t < enter) {
          el.style.opacity = '0';
          el.style.animation = 'none';
        } else if (t >= enter && t < enter + dur) {
          const elapsed = t - enter;
          el.style.animation = `${enterAnim} ${dur}s ease-out 1 forwards`;
          el.style.animationDelay = `-${elapsed}s`;
          el.style.animationPlayState = 'paused';
        } else if (t >= enter + dur && t < exit) {
          el.style.opacity = '1';
          el.style.animation = 'none';
        } else if (t >= exit && t < exit + dur) {
          const elapsed = t - exit;
          el.style.animation = `${exitAnim} ${dur}s ease-in 1 forwards`;
          el.style.animationDelay = `-${elapsed}s`;
          el.style.animationPlayState = 'paused';
        } else {
          el.style.opacity = '0';
          el.style.animation = 'none';
        }
      });
    };
  });

  // But my HTML doesn't use `.aura-el` class — it uses `.scene` with data attrs.
  // The __seek function above targets .aura-el, so I need to re-evaluate with .scene instead.
  // Let me re-inject targeting .scene elements.
  // Actually, the simpler fix: the render script's __seek targets .aura-el,
  // but my elements use class="scene". I need to reconcile this.
  // Approach: override the injected __seek on the page to target .scene instead.
  // The render tool injects its own __seek, but I'll also inject one targeting .scene.
  // Actually, the render tool video-render.ts has a hardcoded __seek that targets .aura-el.
  // My script here is standalone — it doesn't use video-render.ts, it has its own loop.
  // So let me fix the __seek to target .scene instead.

  // Override with the correct selector
  await page.evaluate(() => {
    window.__seek = (t) => {
      document.querySelectorAll('.scene').forEach((el) => {
        const enter = parseFloat(el.dataset.enter || '0');
        const exit = parseFloat(el.dataset.exit || '9999');
        const dur = parseFloat(el.dataset.dur || '0.5');
        const enterAnim = el.dataset.enterAnim || 'fadeIn';
        const exitAnim = el.dataset.exitAnim || 'fadeOut';

        if (t < enter) {
          el.style.opacity = '0';
          el.style.animation = 'none';
        } else if (t >= enter && t < enter + dur) {
          const elapsed = t - enter;
          el.style.animation = `${enterAnim} ${dur}s ease-out 1 forwards`;
          el.style.animationDelay = `-${elapsed}s`;
          el.style.animationPlayState = 'paused';
        } else if (t >= enter + dur && t < exit) {
          el.style.opacity = '1';
          el.style.animation = 'none';
        } else if (t >= exit && t < exit + dur) {
          const elapsed = t - exit;
          el.style.animation = `${exitAnim} ${dur}s ease-in 1 forwards`;
          el.style.animationDelay = `-${elapsed}s`;
          el.style.animationPlayState = 'paused';
        } else {
          el.style.opacity = '0';
          el.style.animation = 'none';
        }
      });
    };
  });

  // ── Capture frames ──
  let lastLogPct = -1;
  const startMs = Date.now();

  for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
    const t = frame / FPS;
    await page.evaluate((time) => { window.__seek?.(time); }, t);
    const fp = path.join(tmpDir, `frame-${String(frame).padStart(6, '0')}.png`);
    await page.screenshot({ path: fp, type: 'png' });

    const pct = Math.round((frame / TOTAL_FRAMES) * 100);
    if (pct >= lastLogPct + 5) {
      lastLogPct = pct;
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      const eta = (elapsed / Math.max(1, frame)) * (TOTAL_FRAMES - frame);
      console.log(`  ${pct}% · frame ${frame}/${TOTAL_FRAMES} · ${elapsed}s elapsed · ~${eta.toFixed(0)}s remaining`);
    }
  }

  await page.close();
} finally {
  await browser.close();
}

console.log('\nFrames captured. Stitching with ffmpeg + adding audio...');

// ── ffmpeg stitch with audio ──
await new Promise((resolve, reject) => {
  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(tmpDir, 'frame-%06d.png'),
    '-i', AURA_MP3,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    OUTPUT,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });
  ffmpeg.on('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
  });
  ffmpeg.on('error', reject);
});

// ── Cleanup ──
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n✓ Done: ${OUTPUT}`);

// Verify
const resultProbe = JSON.parse(execSync(
  `ffprobe -v quiet -print_format json -show_format -show_streams "${OUTPUT}"`,
  { encoding: 'utf8' }
));
const vStream = resultProbe.streams.find(s => s.codec_type === 'video');
const aStream = resultProbe.streams.find(s => s.codec_type === 'audio');
console.log(`  Video: ${vStream?.codec_name} · ${vStream?.width}x${vStream?.height} · ${vStream?.r_frame_rate} fps`);
console.log(`  Audio: ${aStream?.codec_name} · ${aStream?.sample_rate} Hz · ${resultProbe.format.duration}s`);
