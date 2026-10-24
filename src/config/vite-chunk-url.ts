import type { Plugin } from 'vite';

/**
 * `import url from 'virtual:chunk-url:<specifier>'` gives the built URL of
 * the chunk that `import('<specifier>')` loads (resolved like an import from
 * the importing file), or null outside a production build.
 *
 * Why: a failed dynamic import is remembered in the browser's module map for
 * the page's lifetime (Chromium, per the HTML spec), so retrying the same
 * `import()` never re-fetches. Importing the same chunk under a URL with a
 * query string is a new module map entry and does re-fetch (see
 * platform/chunk-loader.ts).
 *
 * Only use it for modules that are already loaded lazily (dynamic import
 * targets): the chunk is emitted explicitly (loaded after its importer), so a
 * module that is statically imported elsewhere would be split out of the
 * chunk it lives in now.
 */
const CHUNK_URL_PREFIX = 'virtual:chunk-url:';
const RESOLVED_PREFIX = '\0' + CHUNK_URL_PREFIX;
// The dev server and vitest serve modules unbundled: there is no chunk to
// name. One id for all, which also keeps target paths out of dev request URLs.
const RESOLVED_DEV_ID = '\0virtual:chunk-url-dev';

export function chunkUrlPlugin(): Plugin {
  let isBuild = false;
  // Resolved virtual id -> the module that imports it.
  const importers = new Map<string, string>();
  return {
    name: 'dash-bridge:chunk-url',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    async resolveId(source, importer) {
      if (!source.startsWith(CHUNK_URL_PREFIX)) return null;
      if (!isBuild) return RESOLVED_DEV_ID;
      const target = source.slice(CHUNK_URL_PREFIX.length);
      const resolved = await this.resolve(target, importer, { skipSelf: true });
      if (!resolved || resolved.external) {
        this.error(`chunk-url: cannot resolve "${target}" from ${importer ?? '(unknown)'}`);
      }
      const id = RESOLVED_PREFIX + resolved.id;
      if (importer) importers.set(id, importer);
      return id;
    },
    load(id) {
      if (id === RESOLVED_DEV_ID) return 'export default null;';
      if (!id.startsWith(RESOLVED_PREFIX)) return null;
      const importer = importers.get(id);
      const ref = this.emitFile({
        type: 'chunk',
        id: id.slice(RESOLVED_PREFIX.length),
        // The chunk is only ever loaded after its importer, as with the
        // dynamic import it mirrors. Without this Rollup must assume it can
        // load first and splits every module it shares with the main bundle
        // out into separate chunks.
        ...(importer ? { implicitlyLoadedAfterOneOf: [importer] } : {}),
      });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
  };
}
