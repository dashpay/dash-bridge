import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the real JSON-RPC DAPIClient but avoid loading @dashevo/dapi-client.
vi.mock('./dapi-subscription.js', () => ({
  DAPISubscriptionClient: vi.fn().mockImplementation(() => ({})),
}));

import { InsightClient } from './insight.js';
import { DAPIClient } from './dapi.js';
import { IslockService } from './islock.js';
import { getFaucetStatus, requestTestnetFunds } from './faucet.js';
import type { NetworkConfig } from '../config.js';

function onAbort(signal: AbortSignal | null | undefined, reject: (reason: unknown) => void): void {
  if (!signal) return;
  if (signal.aborted) reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
}

function stalledHeaders() {
  return vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => onAbort(init?.signal, reject)));
}

function stalledBody(status = 200) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const never = () => new Promise<never>((_, reject) => onAbort(init?.signal, reject));
    return { ok: status < 400, status, statusText: 'X', json: never, text: never } as unknown as Response;
  });
}

const insight = new InsightClient({ insightApiUrl: 'https://insight.test/api' } as NetworkConfig);

/** Track settlement without tripping unhandled-rejection warnings. */
function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  return { promise, settled: () => settled };
}

describe('per-request deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic retry backoff
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Insight UTXO lookup times out instead of hanging deposit detection', async () => {
    vi.stubGlobal('fetch', stalledHeaders());
    const expectation = expect(insight.getUTXOs('yAddr', { maxAttempts: 1 })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.advanceTimersByTimeAsync(8000);
    await expectation;
  });

  it('Insight broadcast bounds the error-body text read', async () => {
    vi.stubGlobal('fetch', stalledBody(400));
    const expectation = expect(insight.broadcastTransaction('00', { maxAttempts: 1 })).rejects.toThrow(
      'Request timeout after 20000ms'
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await expectation;
  });

  it('Insight broadcast keeps the server error text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad-txns-in-belowout', { status: 400 }))
    );
    await expect(insight.broadcastTransaction('00', { maxAttempts: 1 })).rejects.toThrow(
      'Broadcast failed: 400 - bad-txns-in-belowout'
    );
  });

  it('block-height polling forwards its abort signal to the in-flight request', async () => {
    const fetchMock = stalledHeaders();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const polling = track(insight.waitForBlockHeight('tx', 5000, controller.signal));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    // Settles right away: no backoff retries for a cancelled request.
    await expect(polling.promise).rejects.toThrow('Block-height polling aborted');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('JSON-RPC IS-lock wait rejects at its deadline when getislocks stalls', async () => {
    const fetchMock = stalledHeaders();
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();
    const service = new IslockService({ network: 'mainnet' });
    const handle = await service.subscribeForInstantSendLock(
      'txid',
      new Uint8Array([1]),
      { txid: 'prev', vout: 0 },
      60_000,
      onRetry
    );
    const wait = track(handle.wait());

    await vi.advanceTimersByTimeAsync(59_999);
    expect(wait.settled()).toBe(false);
    // Stalled requests were cut off at 8s and retried, not left hanging.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(onRetry).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(wait.promise).rejects.toThrow('Timeout waiting for InstantSend lock for txid after 60000ms');
    // The in-flight request was cancelled at the deadline.
    expect(fetchMock.mock.lastCall?.[1]?.signal?.aborted).toBe(true);
  });

  it('JSON-RPC IS-lock wait rejects at its deadline when the response body stalls', async () => {
    vi.stubGlobal('fetch', stalledBody());
    const client = new DAPIClient({ network: 'testnet' });
    const wait = track(client.waitForInstantSendLock('txid', 30_000));

    await vi.advanceTimersByTimeAsync(29_999);
    expect(wait.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(wait.promise).rejects.toThrow('Timeout waiting for InstantSend lock');
  });

  it('JSON-RPC IS-lock wait rejects at its deadline even mid retry backoff', async () => {
    vi.stubGlobal('fetch', stalledHeaders());
    const client = new DAPIClient({ network: 'testnet' });
    // First request times out at 8s, then withRetry backs off 1s: 8.5s lands in the backoff.
    const wait = track(client.waitForInstantSendLock('txid', 8500));

    await vi.advanceTimersByTimeAsync(8499);
    expect(wait.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(wait.promise).rejects.toThrow('Timeout waiting for InstantSend lock for txid after 8500ms');
  });

  it('JSON-RPC IS-lock wait forwards a caller abort to the in-flight request', async () => {
    const fetchMock = stalledHeaders();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const client = new DAPIClient({ network: 'testnet' });
    const wait = track(client.waitForInstantSendLock('txid', 60_000, undefined, controller.signal));

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(wait.promise).rejects.toThrow('InstantSend lock polling aborted for txid');
  });

  it('faucet status read times out with the existing user-facing message', async () => {
    vi.stubGlobal('fetch', stalledBody());
    const expectation = expect(getFaucetStatus('https://faucet.test')).rejects.toThrow(
      'Request timed out. Please try again.'
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
  });

  it('faucet POST times out before headers with the existing message', async () => {
    vi.stubGlobal('fetch', stalledHeaders());
    const expectation = expect(requestTestnetFunds('https://faucet.test', 'yAddr')).rejects.toThrow(
      'Request timed out. Please try again.'
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
  });

  it('faucet POST bounds the body read, warns funds may be sent, and is not retried', async () => {
    const fetchMock = stalledBody();
    vi.stubGlobal('fetch', fetchMock);
    const expectation = expect(requestTestnetFunds('https://faucet.test', 'yAddr')).rejects.toThrow(
      'wait for the deposit before requesting again'
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
