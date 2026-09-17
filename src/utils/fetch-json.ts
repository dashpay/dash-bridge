/** Bound both response headers and body; forward cancellation to fetch. */
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000
): Promise<any> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signal = init.signal;
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`API error: ${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
