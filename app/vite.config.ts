import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  test: {
    // Only the component tests need a DOM. The engine and helper suites are
    // plain modules, so they declare `@vitest-environment node` and stay fast.
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Tauri's `invoke` throws outside the webview; tests that need it mock it.
    restoreMocks: true,
  },
  build: {
    // safari15, not the scaffold's safari13: esbuild refuses to down-transpile
    // destructuring for safari <15, which d3-drag/d3-zoom (via React Flow) use.
    target:
      process.env.TAURI_ENV_PLATFORM == 'windows'
        ? 'chrome105'
        : 'safari15',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
