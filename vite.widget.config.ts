import { defineConfig } from 'vite';

// Library build for the embeddable widget SDK (docs/widget.md). Runs after the
// app build and writes next to it, so dist/widget.js and dist/widget.mjs are
// published with the site. Deliberately no node polyfills or Dash deps.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2018',
    minify: 'esbuild',
    sourcemap: false,
    lib: {
      entry: 'src/widget/index.ts',
      name: 'DashBridge',
      formats: ['iife', 'es'],
      fileName: (format) => (format === 'es' ? 'widget.mjs' : 'widget.js'),
    },
  },
});
