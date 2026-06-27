import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  waitForInstantSendLock: vi.fn(),
  getBestChainLock: vi.fn(),
  subscribeForInstantSendLock: vi.fn(),
  getTransactionLockStatus: vi.fn(),
  getCoreChainLockedHeight: vi.fn(),
  getPlatformStatus: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('./dapi.js', () => ({
  DAPIClient: vi.fn().mockImplementation((config: { network: string; rpcUrl?: string }) => ({
    network: config.network,
    get hasRpcUrl() {
      return !!config.rpcUrl || config.network === 'mainnet' || config.network === 'testnet';
    },
    waitForInstantSendLock: mocks.waitForInstantSendLock,
    getBestChainLock: mocks.getBestChainLock,
  })),
}));

vi.mock('./dapi-subscription.js', () => ({
  DAPISubscriptionClient: vi.fn().mockImplementation(() => ({
    subscribeForInstantSendLock: mocks.subscribeForInstantSendLock,
    getTransactionLockStatus: mocks.getTransactionLockStatus,
    getCoreChainLockedHeight: mocks.getCoreChainLockedHeight,
    getPlatformStatus: mocks.getPlatformStatus,
    disconnect: mocks.disconnect,
  })),
}));

import { IslockService } from './islock.js';

describe('IslockService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTransactionLockStatus.mockResolvedValue(null);
  });

  it('uses JSON-RPC only on mainnet to avoid browser DAPI stream discovery', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    mocks.waitForInstantSendLock.mockResolvedValue(bytes);
    const service = new IslockService({ network: 'mainnet' });
    const progress: string[] = [];

    const handle = await service.subscribeForInstantSendLock(
      'txid',
      new Uint8Array([4]),
      { txid: 'prevout', vout: 0 },
      1234,
      undefined,
      (message) => progress.push(message)
    );

    expect(mocks.waitForInstantSendLock).toHaveBeenCalledOnce();
    expect(mocks.waitForInstantSendLock.mock.calls[0][0]).toBe('txid');
    expect(mocks.waitForInstantSendLock.mock.calls[0][1]).toBe(1234);
    expect(mocks.subscribeForInstantSendLock).not.toHaveBeenCalled();
    expect(mocks.getTransactionLockStatus).not.toHaveBeenCalled();
    expect(progress).toEqual(['Polling InstantSend lock...']);
    await expect(handle.wait()).resolves.toBe(bytes);
  });

  it('keeps the pre-broadcast DAPI subscription path for devnets without RPC', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const subHandle = { wait: vi.fn().mockResolvedValue(bytes) };
    mocks.subscribeForInstantSendLock.mockResolvedValue(subHandle);
    const service = new IslockService({ network: 'devnet-paloma', dapiAddresses: ['https://127.0.0.1:1443'] });

    const handle = await service.subscribeForInstantSendLock(
      'txid',
      new Uint8Array([4]),
      { txid: 'prevout', vout: 0 }
    );

    expect(mocks.waitForInstantSendLock).not.toHaveBeenCalled();
    expect(mocks.subscribeForInstantSendLock).toHaveBeenCalledOnce();
    await expect(handle.wait()).resolves.toBe(bytes);
  });
});
