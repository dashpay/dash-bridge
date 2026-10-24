import { defineConfig } from 'vitest/config';
import { chunkUrlPlugin } from './src/config/vite-chunk-url.js';

export default defineConfig({
  plugins: [chunkUrlPlugin()],
  test: {
    exclude: [
      'e2e/**',
      'node_modules/**',
      'dist/**',
    ],
  },
});
