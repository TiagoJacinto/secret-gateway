// Builds the review page (web/) into web/dist and serves it on its own origin, 127.0.0.1:8788, under /review/.
// The gateway allows browser access from that origin only (REVIEW_WEB_ORIGIN).
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: '/review/',
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  build: { outDir: 'dist', emptyOutDir: true },
  preview: { host: '127.0.0.1', port: 8788, strictPort: true },
});
