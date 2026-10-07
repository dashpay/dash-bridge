/** Thrown by fetchWithDeadline when its own timeout (not the caller) aborts the request. */
export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    // "timeout" keeps this retryable under isRetryableError().
    super(`Request timeout after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * Sibling of fetchJson (./fetch-json.ts) for call sites that need the raw
 * Response, e.g. to read a text error body or keep their own status handling
 * and error messages. `timeoutMs` bounds the response headers and whatever
 * body read `read` performs. A caller `init.signal` is forwarded; a caller
 * abort rejects with fetch's AbortError, a timeout with RequestTimeoutError.
 */
export async function fetchWithDeadline<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  read: (response: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signal = init.signal;
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await read(response);
  } catch (error) {
    if (timedOut && !signal?.aborted && (error as { name?: string })?.name === 'AbortError') {
      throw new RequestTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
