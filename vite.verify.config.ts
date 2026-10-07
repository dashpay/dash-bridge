import { defineConfig } from 'vite';

// "Sign in with Dash" verifier (docs/widget.md): dist/widget-verify.mjs, a
// self-contained ES module for app servers (Node 18+) and browsers. Kept out
// of widget.js so the SDK stays small; it bundles @noble/secp256k1 and
// @noble/hashes. es2020 for BigInt.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2020',
    lib: {
      entry: 'src/widget/verify.ts',
      formats: ['es'],
      fileName: () => 'widget-verify.mjs',
    },
  },
});
