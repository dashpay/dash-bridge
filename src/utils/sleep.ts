/**
 * Sleep for `ms` milliseconds, returning early if `signal` aborts.
 *
 * Does not throw on abort — callers should check `signal.aborted` after the
 * await to decide whether to continue their poll loop.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
