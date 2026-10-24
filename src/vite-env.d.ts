/// <reference types="vite/client" />

/** Built URL of a lazily imported chunk; null in dev and tests. See src/config/vite-chunk-url.ts. */
declare module 'virtual:chunk-url:*' {
  const url: string | null;
  export default url;
}
