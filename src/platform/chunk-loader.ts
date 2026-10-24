/**
 * Lazy chunk loading that survives a dropped download.
 *
 * Browsers remember a failed `import()` for the page's lifetime (Chromium
 * follows the HTML spec's module map; iOS WebKit may too), so retrying the same
 * import rejects again without touching the network. Retries therefore import
 * the chunk's built URL with a query string, which is a new module map entry.
 * The chunk's own static imports still resolve to the shared, already-loaded
 * modules, so nothing is instantiated twice.
 *
 * iOS Safari: a programmatic file download (the key backup) raises "Do you
 * want to download …?", and until the user answers it the page's loads fail.
 * That is how the EvoSDK chunk got poisoned mid-flow. Funding flows therefore
 * load their chunks before the first backup download; as a fallback, a load
 * failing right after a download retries for about a minute and says why.
 */

/** Thrown when a lazily loaded part of the app could not be downloaded. */
export class ChunkLoadError extends Error {
  readonly chunk: string;
  readonly attempts: number;
  /** A file download had just started, so a browser download prompt may have blocked the load. */
  readonly downloadPromptSuspected: boolean;

  constructor(chunk: string, attempts: number, cause: unknown, downloadPromptSuspected = false) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Could not load the "${chunk}" component after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${reason}`);
    this.name = 'ChunkLoadError';
    this.chunk = chunk;
    this.attempts = attempts;
    this.downloadPromptSuspected = downloadPromptSuspected;
    (this as { cause?: unknown }).cause = cause;
  }
}

interface ChunkLoaderOptions {
  /** Overridable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Imports a URL (overridable for tests). */
  importUrl?: (url: string) => Promise<unknown>;
}

/** Delay before each retry. */
const RETRY_DELAYS_MS: readonly number[] = [500, 1500];
export const CHUNK_LOAD_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** Retry delays while a download prompt may be open (about a minute in total). */
const PROMPT_RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 10000, 15000, 30000];
const DOWNLOAD_PROMPT_WINDOW_MS = 60_000;

let lastDownloadStartedAt = -Infinity;

/** Call when the page starts a file download (it may raise a prompt that blocks loads). */
export function noteDownloadStarted(now = Date.now()): void {
  lastDownloadStartedAt = now;
}

function downloadPromptMayBeOpen(): boolean {
  return Date.now() - lastDownloadStartedAt < DOWNLOAD_PROMPT_WINDOW_MS;
}

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
 * load; a failed download is retried with backoff (re-fetching under a
 * cache-busted URL when the chunk URL is known), then the memo is cleared so a
 * later call starts over, and a ChunkLoadError naming the chunk is thrown.
 * Every cache-busted URL is used once per page: the browser remembers the ones
 * that failed, so a later round must not repeat them. Errors other than a
 * failed download (TypeError), e.g. a SyntaxError while evaluating, are not
 * retried.
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
  const sleep = options.sleep ?? defaultSleep;
  const importUrl = options.importUrl ?? defaultImportUrl;
  // Across rounds: once the plain import failed, the browser may answer it
  // from its module map forever, and each busted URL is likewise good once.
  let plainImportFailed = false;
  let bustedUrls = 0;

  const loadOnce = async (): Promise<T> => {
    if (!chunkUrl || !plainImportFailed) {
      try {
        return await load();
      } catch (error) {
        plainImportFailed = true;
        throw error;
      }
    }
    bustedUrls += 1;
    return (await importUrl(cacheBustedUrl(chunkUrl, bustedUrls))) as T;
  };

  const loadWithRetries = async (): Promise<T> => {
    // Picked at the first failure: a download prompt that is open then keeps
    // every load failing until the user answers it.
    let delays = RETRY_DELAYS_MS;
    let promptSuspected = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await loadOnce();
      } catch (error) {
        if (!(error instanceof TypeError)) throw new ChunkLoadError(chunk, attempt + 1, error);
        if (attempt === 0 && downloadPromptMayBeOpen()) {
          delays = PROMPT_RETRY_DELAYS_MS;
          promptSuspected = true;
        }
        const attempts = delays.length + 1;
        const retryDelay: number | undefined = delays[attempt];
        const retrying = retryDelay === undefined ? '' : `; retrying in ${retryDelay} ms`;
        const why = promptSuspected ? ' (a file download just started; its prompt may be blocking loads)' : '';
        console.warn(`Chunk "${chunk}" failed to load (attempt ${attempt + 1}/${attempts})${why}${retrying}:`, error);
        if (retryDelay === undefined) throw new ChunkLoadError(chunk, attempts, error, promptSuspected);
        await sleep(retryDelay);
      }
    }
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
