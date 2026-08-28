import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web client builds into dist/web, which `aura serve` serves statically and
// a future Tauri shell can load as its frontend without a rewrite. Relative
// base so it works from a file:// origin in the desktop shell too.
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // Content-hashed names. Stable names plus a cacheable max-age means an
    // upgraded client keeps serving the previous bundle out of the browser
    // cache until it expires — which is how a fixed client still looks broken
    // after a release. The hash makes each build a distinct URL, so index.html
    // (served no-store) is the only thing that ever needs revalidating.
    rollupOptions: {
      output: {
        entryFileNames: 'app-[hash].js',
        chunkFileNames: 'chunk-[hash].js',
        assetFileNames: 'app-[hash].[ext]',
      },
    },
  },
  server: {
    port: 5273,
    // `npm run dev:web` talks to a running `aura serve` on 4317.
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
    },
  },
});
