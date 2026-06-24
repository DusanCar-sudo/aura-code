#!/usr/bin/env npx tsx
// ─────────────────────────────────────────────────────────────────────────────
// render-animations.ts — Render :report and :driven flow animations to MP4
// Usage: npx tsx render-animations.ts [report|driven|both]
// ─────────────────────────────────────────────────────────────────────────────

import { renderVideo } from './src/tools/video-render.js';
import * as path from 'path';

const ROOT = path.resolve(__dirname || '.');

const configs: Record<string, { html: string; output: string; duration: number }> = {
  report: {
    html: path.join(ROOT, 'report-animation.html'),
    output: path.join(ROOT, 'report-flow.mp4'),
    duration: 14,
  },
  driven: {
    html: path.join(ROOT, 'driven-animation.html'),
    output: path.join(ROOT, 'driven-flow.mp4'),
    duration: 22,
  },
};

async function main() {
  const arg = process.argv[2] || 'both';
  const targets = arg === 'both' ? ['report', 'driven'] : [arg];

  if (!targets.every(t => t in configs)) {
    console.error(`Usage: npx tsx render-animations.ts [report|driven|both]`);
    process.exit(1);
  }

  for (const name of targets) {
    const cfg = configs[name];
    console.log(`\n🎬 Rendering "${name}" → ${cfg.output}`);
    console.log(`   Duration: ${cfg.duration}s, FPS: 30, Resolution: 1920×1080`);

    const start = Date.now();
    const result = await renderVideo({
      htmlPath: cfg.html,
      output: cfg.output,
      fps: 30,
      width: 1920,
      height: 1080,
      duration: cfg.duration,
      onProgress: (current, total) => {
        const pct = Math.round((current / total) * 100);
        process.stdout.write(`\r   Frames: ${current}/${total} (${pct}%)`);
      },
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\r   ✅ Done in ${elapsed}s → ${result}`);
  }

  console.log('\n🎉 All done!\n');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
