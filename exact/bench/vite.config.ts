// Copy of bench/vite.config.ts with two changes only: the tauri-core shim
// alias points at exact/bench/shim/ (which adds the huge-diff override for
// PR #40010), and the default output dir is exact/bench/dist-rust. The Rust
// app's own code and bench/ stay untouched.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = process.env.BENCH_ROOT ?? fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root,
  logLevel: 'warn',
  define: { 'import.meta.env.VITE_PR_REVIEW_HARNESS': JSON.stringify('1') },
  resolve: {
    alias: {
      '@tauri-apps/api/core': fileURLToPath(new URL('./shim/tauri-core.ts', import.meta.url)),
      '@tauri-apps/api/window': fileURLToPath(new URL('./shim/tauri-window.ts', import.meta.url)),
      '@tauri-apps/plugin-updater': fileURLToPath(new URL('./shim/tauri-updater.ts', import.meta.url)),
      '@tauri-apps/plugin-process': fileURLToPath(new URL('./shim/tauri-process.ts', import.meta.url)),
    },
  },
  worker: { format: 'es' },
  build: { outDir: process.env.BENCH_OUT ?? fileURLToPath(new URL('./dist-rust', import.meta.url)), emptyOutDir: true, target: 'safari16', reportCompressedSize: false, chunkSizeWarningLimit: 5000 },
});
