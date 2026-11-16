// Builds the review page (web/) into web/dist. The gateway serves that build under /review/.
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: '/review/',
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  build: { outDir: 'dist', emptyOutDir: true },
});
