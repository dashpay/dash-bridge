import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { shouldPreloadDashChunk } from './src/config/vite-preload.js';
import { chunkUrlPlugin } from './src/config/vite-chunk-url.js';

export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [
    chunkUrlPlugin(),
    nodePolyfills({
      include: ['util', 'stream', 'events', 'buffer', 'process', 'path', 'os', 'string_decoder', 'crypto'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  build: {
    target: 'es2020',
    modulePreload: {
      resolveDependencies: (_filename, deps) =>
        deps.filter(shouldPreloadDashChunk),
    },
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    rollupOptions: {
      output: {
        // Merge tiny shared chunks (the 0.24 kB commonjs helper the islock and
        // evo-sdk chunks share) into a chunk that is always loaded with them:
        // the entry. A lazy chunk then depends only on the already loaded
        // entry. WebKit keeps a failed fetch of a static dependency across
        // reloads, so a dropped download of such a shared chunk would make
        // the lazy chunks that import it unloadable until the tab is closed.
        experimentalMinChunkSize: 1024,
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2020',
    },
    include: [
      '@dashevo/dapi-client',
      '@dashevo/dashcore-lib',
    ],
  },
});
