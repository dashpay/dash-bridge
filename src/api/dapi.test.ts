import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAPIClient } from './dapi.js';

// A structurally valid deterministic InstantSend lock (signature is a fixture).
const txid = '22'.repeat(32);
const lockHex = '0101' + '11'.repeat(32) + '00000000' + txid + '33'.repeat(32) + '44'.repeat(96);
const fetchMock = vi.fn();
const client = new DAPIClient({ network: 'testnet', rpcUrl: 'https://rpc.example.invalid' });
const reply = (result: unknown) => ({ ok: true, json: async () => ({ result }) });

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('optional InstantSend RPC', () => {
  it('has no provider when no URL is configured', () => {
    expect(new DAPIClient({ network: 'testnet' }).hasRpcUrl).toBe(false);
    expect(new DAPIClient({ network: 'mainnet' }).hasRpcUrl).toBe(false);
  });

  it('polls empty results and returns a valid matching lock', async () => {
    fetchMock.mockResolvedValueOnce(reply([])).mockResolvedValue(reply([{ txid, hex: lockHex }]));
    const result = client.waitForInstantSendLock(txid);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toEqual(new Uint8Array(Buffer.from(lockHex, 'hex')));
    expect(fetchMock.mock.calls[0][0]).toBe('https://rpc.example.invalid');
  });

  it('yields after three blocked requests instead of polling forever', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = expect(client.waitForInstantSendLock(txid)).rejects.toThrow('Failed to fetch');
    await vi.advanceTimersByTimeAsync(12000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('aborts a stalled request at the overall polling deadline', async () => {
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      requestSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const result = expect(client.waitForInstantSendLock(txid, 1000)).rejects.toThrow('Timeout');
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight request when a broadcast fails', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const result = expect(client.waitForInstantSendLock(txid, 60000, undefined, controller.signal)).rejects.toThrow('aborted');
    controller.abort();
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { error: { code: -32601, message: 'Method not found' } },
    { result: [{ txid, hex: 'abz' }] },
    { result: [{ txid, hex: lockHex.replace(txid, '55'.repeat(32)) }] },
    { result: {} },
  ])('surfaces provider errors/malformed locks for recovery', async (body) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => body });
    const result = expect(client.waitForInstantSendLock(txid)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(12000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid heights instead of claiming a healthy RPC', async () => {
    fetchMock.mockResolvedValue(reply({ height: -1 }));
    await expect(client.getBestChainLock()).rejects.toThrow('Invalid chain-lock height');
  });
});
