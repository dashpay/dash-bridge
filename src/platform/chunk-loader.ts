/**
 * Lazy chunk loading that survives a dropped download.
 *
 * Browsers remember a failed `import()` for the page's lifetime (Chromium
 * follows the HTML spec's module map; iOS WebKit may too), so retrying the same
 * import rejects again without touching the network. Retries therefore import
 * the chunk's built URL with a query string, which is a new module map entry.
 * The chunk's own static imports still resolve to the shared, already-loaded
 * modules, so nothing is instantiated twice.
 */

/** Thrown when a lazily loaded part of the app could not be downloaded. */
export class ChunkLoadError extends Error {
  readonly chunk: string;
  readonly attempts: number;

  constructor(chunk: string, attempts: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Could not load the "${chunk}" component after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${reason}`);
    this.name = 'ChunkLoadError';
    this.chunk = chunk;
    this.attempts = attempts;
    (this as { cause?: unknown }).cause = cause;
  }
}

export function isChunkLoadError(error: unknown): error is ChunkLoadError {
  return error instanceof ChunkLoadError;
}

export interface ChunkLoaderOptions {
  /** Delay before each retry; its length + 1 is the attempt count. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Imports a URL (overridable for tests). */
  importUrl?: (url: string) => Promise<unknown>;
}

export const CHUNK_RETRY_DELAYS_MS = [500, 1500] as const;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultImportUrl = (url: string) => import(/* @vite-ignore */ url);

/** Unique per page load, so a CDN cannot answer the retry from a cached error. */
const pageToken = Date.now().toString(36);

export function cacheBustedUrl(url: string, attempt: number): string {
  const parsed = new URL(url, globalThis.location?.href);
  parsed.searchParams.set('retry', `${attempt}.${pageToken}`);
  return parsed.href;
}

/**
 * Memoized loader for a lazily imported chunk. Concurrent callers share one
 * load; a failed load is retried with backoff (re-fetching under a cache-busted
 * URL when the chunk URL is known), then the memo is cleared so a later call
 * starts over, and a ChunkLoadError naming the chunk is thrown.
 *
 * @param chunk name for logs and the error screen
 * @param chunkUrl built URL of the chunk (virtual:chunk-url), null in dev
 * @param load the plain dynamic import
 */
export function createChunkLoader<T>(
  chunk: string,
  chunkUrl: string | null,
  load: () => Promise<T>,
  options: ChunkLoaderOptions = {}
): () => Promise<T> {
  const retryDelays = options.retryDelaysMs ?? CHUNK_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const importUrl = options.importUrl ?? defaultImportUrl;
  const attempts = retryDelays.length + 1;

  const loadWithRetries = async (): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(retryDelays[attempt - 1]);
      try {
        if (attempt === 0 || !chunkUrl) return await load();
        return (await importUrl(cacheBustedUrl(chunkUrl, attempt))) as T;
      } catch (error) {
        lastError = error;
        const next = attempt + 1 < attempts ? `; retrying in ${retryDelays[attempt]} ms` : '';
        console.warn(`Chunk "${chunk}" failed to load (attempt ${attempt + 1}/${attempts})${next}:`, error);
      }
    }
    throw new ChunkLoadError(chunk, attempts, lastError);
  };

  let promise: Promise<T> | null = null;
  return () => {
    if (!promise) {
      promise = loadWithRetries().catch((err) => {
        promise = null;
        throw err;
      });
    }
    return promise;
  };
}
