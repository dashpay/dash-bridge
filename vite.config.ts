import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [
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
        deps.filter((dep) => !/evo-sdk|dapi-client|dashcore-lib|dapi-subscription/.test(dep)),
    },
    commonjsOptions: {
      transformMixedEsModules: true,
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
