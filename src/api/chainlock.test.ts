import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForChainLock } from './chainlock.js';
import type { InsightClient } from './insight.js';
import type { IslockService } from './islock.js';

const getTransaction = vi.fn();
const getCoreChainLockedHeight = vi.fn();
const insight = { getTransaction } as unknown as InsightClient;
const islock = { getCoreChainLockedHeight } as unknown as IslockService;

beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('chain proof readiness', () => {
  it('waits for mining and Platform catching up, without an RPC provider', async () => {
    getTransaction.mockResolvedValueOnce({ confirmations: 0 }).mockResolvedValue({ blockheight: 100 });
    getCoreChainLockedHeight.mockResolvedValueOnce(99).mockResolvedValueOnce(99).mockResolvedValue(100);
    const progress = vi.fn();
    const ready = vi.fn();
    const result = waitForChainLock('tx', insight, islock, new AbortController().signal, progress).then(ready);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(ready).toHaveBeenCalledWith(100);
    expect(progress).toHaveBeenLastCalledWith({ blockHeight: 100, chainLockedHeight: 100 });
  });

  it('does not reuse a previous transaction height after a reorg or failed read', async () => {
    getTransaction.mockResolvedValueOnce({ blockheight: 100 }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ blockheight: 102 });
    getCoreChainLockedHeight.mockResolvedValueOnce(99).mockResolvedValueOnce(100).mockResolvedValue(102);
    const ready = vi.fn();
    const result = waitForChainLock('tx', insight, islock, new AbortController().signal, vi.fn()).then(ready);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(ready).toHaveBeenCalledWith(102);
  });

  it.each([undefined, NaN, Infinity, -1, 99.5])('never treats %s as a chain lock', async (height) => {
    getTransaction.mockResolvedValue({ blockheight: 90, confirmations: 100 });
    getCoreChainLockedHeight.mockResolvedValue(height);
    const controller = new AbortController();
    const progress = vi.fn();
    const result = waitForChainLock('tx', insight, islock, controller.signal, progress);
    const assertion = expect(result).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(10000);
    controller.abort();
    await assertion;
    expect(progress).toHaveBeenCalled();
  });

  it('ignores late responses after cancellation', async () => {
    let resolve!: (value: { blockheight: number }) => void;
    getTransaction.mockReturnValue(new Promise((r) => { resolve = r; }));
    getCoreChainLockedHeight.mockResolvedValue(100);
    const controller = new AbortController();
    const progress = vi.fn();
    const result = waitForChainLock('tx', insight, islock, controller.signal, progress);
    const assertion = expect(result).rejects.toThrow('cancelled');
    controller.abort();
    resolve({ blockheight: 100 });
    await assertion;
    expect(progress).not.toHaveBeenCalled();
  });

  it('settles cancellation while Platform status is still pending', async () => {
    getTransaction.mockResolvedValue({ blockheight: 100 });
    getCoreChainLockedHeight.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const progress = vi.fn();
    const rejected = vi.fn();
    void waitForChainLock('tx', insight, islock, controller.signal, progress).catch(rejected);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledWith(new Error('Chain-lock wait cancelled'));
    expect(progress).not.toHaveBeenCalled();
  });
});
