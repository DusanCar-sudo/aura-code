/// <reference lib="dom" />
/// <reference lib="dom" />
// ─────────────────────────────────────────────────────────────────────────────
// Video Renderer — Puppeteer frame capture + ffmpeg MP4 encoding
// Takes an HTML file with CSS animations, captures every frame via Puppeteer,
// pipes PNGs to ffmpeg, produces an MP4.  No new dependencies required.
// ─────────────────────────────────────────────────────────────────────────────

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync, spawn } from 'child_process';

export interface RenderOptions {
  htmlPath: string;
  output: string;
  fps?: number;
  width?: number;
  height?: number;
  duration?: number;
  keepFrames?: boolean;
  onProgress?: (current: number, total: number) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome detection
// ─────────────────────────────────────────────────────────────────────────────

function findChrome(): string {
  const candidates = [
    'google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium',
  ];
  for (const cmd of candidates) {
    try {
      const result = execSync(`which ${cmd}`, { stdio: 'pipe' });
      return result.toString().trim();
    } catch {}
  }
  // Direct paths as fallback
  const directPaths = [
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ];
  for (const p of directPaths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome/Chromium not found.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main render function
// ─────────────────────────────────────────────────────────────────────────────

export async function renderVideo(options: RenderOptions): Promise<string> {
  const {
    htmlPath, output,
    fps = 30, width = 1920, height = 1080,
    keepFrames = false, onProgress,
  } = options;

  const absHtml = path.resolve(htmlPath);
  if (!fs.existsSync(absHtml)) throw new Error(`HTML not found: ${absHtml}`);

  const absOutput = path.resolve(output);
  const outDir = path.dirname(absOutput);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-video-'));
  const framePattern = path.join(tmpDir, 'frame-%06d.png');

  // Puppeteer
  const puppeteer = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  let totalFrames = 0;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(`file://${absHtml}`, { waitUntil: 'networkidle0', timeout: 15000 });

    const pageDuration = options.duration ??
      (await page.evaluate(() => {
        const el = document.getElementById('__duration');
        return el ? parseFloat(el.textContent || '5') : 5;
      }));

    totalFrames = Math.ceil(pageDuration * fps);

    // Inject animation seek controller
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.id = '__aura-control';
      style.textContent = `.aura-el { animation-play-state: paused !important; opacity: 0; }`;
      document.head.appendChild(style);

      (window as any).__seek = (t: number) => {
        document.querySelectorAll('.aura-el').forEach((el: any) => {
          const enter = parseFloat(el.dataset.enter || '0');
          const exit = parseFloat(el.dataset.exit || '9999');
          const dur = parseFloat(el.dataset.dur || '0.5');
          const enterAnim = el.dataset.enterAnim || 'fadeIn';
          const exitAnim = el.dataset.exitAnim || 'fadeOut';
          const centered = 'translate(-50%, -50%)';

          if (t < enter) {
            el.style.opacity = '0';
            el.style.animation = 'none';
            el.style.transform = centered;
          } else if (t >= enter && t < enter + dur) {
            const elapsed = t - enter;
            el.style.animation = `${enterAnim} ${dur}s ease-out 1 forwards`;
            el.style.animationDelay = `-${elapsed}s`;
            el.style.animationPlayState = 'paused';
          } else if (t >= enter + dur && t < exit) {
            el.style.opacity = '1';
            el.style.animation = 'none';
            el.style.transform = centered;
          } else if (t >= exit && t < exit + dur) {
            const elapsed = t - exit;
            el.style.animation = `${exitAnim} ${dur}s ease-in 1 forwards`;
            el.style.animationDelay = `-${elapsed}s`;
            el.style.animationPlayState = 'paused';
          } else {
            el.style.opacity = '0';
            el.style.animation = 'none';
            el.style.transform = centered;
          }
        });
      };
    });

    // Capture frames
    let lastLog = -1;
    for (let frame = 0; frame < totalFrames; frame++) {
      const t = frame / fps;
      await page.evaluate((time) => { (window as any).__seek?.(time); }, t);
      const fp = path.join(tmpDir, `frame-${String(frame).padStart(6, '0')}.png`);
      await page.screenshot({ path: fp, type: 'png' });

      const pct = Math.round((frame / totalFrames) * 100);
      if (pct >= lastLog + 10) { lastLog = pct; onProgress?.(frame, totalFrames); }
    }
    await page.close();
  } finally {
    await browser.close();
  }
  onProgress?.(totalFrames, totalFrames);

  // ffmpeg stitch
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y', '-framerate', String(fps), '-i', framePattern,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', absOutput,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    ffmpeg.on('close', (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
    ffmpeg.on('error', reject);
  });

  if (!keepFrames) fs.rmSync(tmpDir, { recursive: true, force: true });
  return absOutput;
}
