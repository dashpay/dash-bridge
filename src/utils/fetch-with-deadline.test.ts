import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from './fetch-json.js';
import { fetchWithDeadline, RequestTimeoutError } from './fetch-with-deadline.js';

/** Reject like real fetch does when the request signal aborts. */
function onAbort(signal: AbortSignal | null | undefined, reject: (reason: unknown) => void): void {
  if (!signal) return;
  if (signal.aborted) reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
}

/** fetch that never sends response headers. */
function stalledHeaders() {
  return vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => onAbort(init?.signal, reject)));
}

/** fetch whose headers arrive but whose body never finishes. */
function stalledBody() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const never = () => new Promise<never>((_, reject) => onAbort(init?.signal, reject));
    return { ok: true, status: 200, statusText: 'OK', json: never, text: never } as unknown as Response;
  });
}

const readJson = async (response: Response) => response.json();

describe('request deadline helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetchJson times out when fetch never resolves', async () => {
    vi.stubGlobal('fetch', stalledHeaders());
    const expectation = expect(fetchJson('https://x/a', {}, 1000)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  it('fetchJson times out when json() never resolves', async () => {
    vi.stubGlobal('fetch', stalledBody());
    const expectation = expect(fetchJson('https://x/a', {}, 1000)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  it('fetchJson forwards a caller abort to fetch', async () => {
    const fetchMock = stalledHeaders();
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();
    const expectation = expect(fetchJson('https://x/a', { signal: caller.signal }, 60_000)).rejects.toMatchObject({
      name: 'AbortError',
    });
    caller.abort();
    await expectation;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('fetchWithDeadline reports its own timeout as RequestTimeoutError', async () => {
    vi.stubGlobal('fetch', stalledHeaders());
    const expectation = expect(fetchWithDeadline('https://x/a', {}, 1000, readJson)).rejects.toBeInstanceOf(
      RequestTimeoutError
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  it('fetchWithDeadline bounds the body read', async () => {
    vi.stubGlobal('fetch', stalledBody());
    const expectation = expect(
      fetchWithDeadline('https://x/a', {}, 1000, async (response) => response.text())
    ).rejects.toThrow('Request timeout after 1000ms');
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  it('fetchWithDeadline forwards a caller abort as AbortError, not a timeout', async () => {
    vi.stubGlobal('fetch', stalledBody());
    const caller = new AbortController();
    const result = fetchWithDeadline('https://x/a', { signal: caller.signal }, 60_000, readJson);
    const expectation = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10);
    caller.abort();
    await expectation;
  });
});
