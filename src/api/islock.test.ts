import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  waitForInstantSendLock: vi.fn(),
  getBestChainLock: vi.fn(),
  subscribeForInstantSendLock: vi.fn(),
  getTransactionLockStatus: vi.fn(),
  getCoreChainLockedHeight: vi.fn(),
  getPlatformStatus: vi.fn(),
  disconnect: vi.fn(),
  fetchPlatformStatus: vi.fn(),
}));

vi.mock('./dapi.js', () => ({
  DAPIClient: vi.fn().mockImplementation((config: { network: string; rpcUrl?: string }) => ({
    network: config.network,
    get hasRpcUrl() {
      return !!config.rpcUrl;
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

vi.mock('../platform/status.js', () => ({ fetchPlatformStatus: mocks.fetchPlatformStatus }));

import { IslockService } from './islock.js';

describe('IslockService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTransactionLockStatus.mockResolvedValue(null);
  });

  it('uses explicitly configured RPC without browser DAPI stream discovery', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    mocks.waitForInstantSendLock.mockResolvedValue(bytes);
    const service = new IslockService({ network: 'mainnet', rpcUrl: 'https://rpc.example.invalid' });
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

  it.each(['mainnet', 'testnet'])('uses chain proofs on %s without legacy seed discovery', async (network) => {
    const service = new IslockService({ network });
    const handle = await service.subscribeForInstantSendLock('txid', new Uint8Array([4]), { txid: 'prevout', vout: 0 });
    await expect(handle.wait()).rejects.toThrow('disabled');
    expect(mocks.waitForInstantSendLock).not.toHaveBeenCalled();
    expect(mocks.subscribeForInstantSendLock).not.toHaveBeenCalled();
  });

  it('keeps the pre-broadcast DAPI subscription path for devnets without RPC', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const subHandle = { wait: vi.fn().mockResolvedValue(bytes) };
    mocks.subscribeForInstantSendLock.mockResolvedValue(subHandle);
    const service = new IslockService({ network: 'devnet-moutai', dapiAddresses: ['https://127.0.0.1:1443'] });

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

for (const network of ['mainnet', 'testnet']) {
  it(`reads ${network} chain-lock progress independently of RPC and legacy DAPI discovery`, async () => {
    vi.clearAllMocks();
    mocks.fetchPlatformStatus.mockResolvedValue({ coreChainLockedHeight: 100 });
    const service = new IslockService({ network });
    await expect(service.getCoreChainLockedHeight()).resolves.toBe(100);
    expect(mocks.fetchPlatformStatus).toHaveBeenCalledWith(network);
    expect(mocks.getBestChainLock).not.toHaveBeenCalled();
    expect(mocks.getPlatformStatus).not.toHaveBeenCalled();
  });
}
