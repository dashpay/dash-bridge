import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  waitForInstantSendLock: vi.fn(),
  getBestChainLock: vi.fn(),
  subscribeForInstantSendLock: vi.fn(),
  getTransactionLockStatus: vi.fn(),
  getCoreChainLockedHeight: vi.fn(),
  getPlatformStatus: vi.fn(),
  warmEvonodeDiscovery: vi.fn(),
  disconnect: vi.fn(),
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
    warmEvonodeDiscovery: mocks.warmEvonodeDiscovery,
    disconnect: mocks.disconnect,
  })),
}));

import { IslockService, PRE_BROADCAST_RETRY_DELAYS_MS } from './islock.js';

describe('IslockService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTransactionLockStatus.mockResolvedValue(null);
  });

  it('uses JSON-RPC only for a devnet that configures its own rpcUrl', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    mocks.waitForInstantSendLock.mockResolvedValue(bytes);
    const service = new IslockService({ network: 'devnet-moutai', rpcUrl: 'https://rpc.devnet.test' });
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

  it('uses the DAPI subscription on testnet (no JSON-RPC since V24)', async () => {
    const { TESTNET } = await import('../config.js');
    const bytes = new Uint8Array([5, 6]);
    mocks.subscribeForInstantSendLock.mockResolvedValue({ wait: vi.fn().mockResolvedValue(bytes) });
    const service = new IslockService({
      network: 'testnet',
      rpcUrl: TESTNET.rpcUrl,
    });

    expect(TESTNET.rpcUrl).toBeUndefined();
    // No built-in list: the subscription discovers testnet evonodes itself.
    expect(TESTNET.dapiAddresses).toBeUndefined();
    expect(service.supportsJsonRpc).toBe(false);
    const handle = await service.subscribeForInstantSendLock('txid', new Uint8Array([4]), { txid: 'prevout', vout: 0 });

    expect(mocks.waitForInstantSendLock).not.toHaveBeenCalled();
    expect(mocks.subscribeForInstantSendLock).toHaveBeenCalledOnce();
    await expect(handle.wait()).resolves.toBe(bytes);
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

  it('uses the DAPI subscription on mainnet too: no JSON-RPC service anywhere by default', async () => {
    const { MAINNET } = await import('../config.js');
    const bytes = new Uint8Array([7]);
    mocks.subscribeForInstantSendLock.mockResolvedValue({ wait: vi.fn().mockResolvedValue(bytes) });
    const service = new IslockService({ network: 'mainnet', rpcUrl: MAINNET.rpcUrl });

    expect(MAINNET.rpcUrl).toBeUndefined();
    expect(service.supportsJsonRpc).toBe(false);
    const handle = await service.subscribeForInstantSendLock('txid', new Uint8Array([4]), { txid: 'prevout', vout: 0 });

    expect(mocks.waitForInstantSendLock).not.toHaveBeenCalled();
    await expect(handle.wait()).resolves.toBe(bytes);
  });

  it('warms evonode discovery on testnet and mainnet but not on JSON-RPC networks', async () => {
    mocks.warmEvonodeDiscovery.mockResolvedValue(undefined);

    await new IslockService({ network: 'testnet' }).warmEvonodeDiscovery();
    await new IslockService({ network: 'mainnet' }).warmEvonodeDiscovery();
    expect(mocks.warmEvonodeDiscovery).toHaveBeenCalledTimes(2);

    await new IslockService({ network: 'devnet-moutai', rpcUrl: 'https://rpc.devnet.test' }).warmEvonodeDiscovery();
    expect(mocks.warmEvonodeDiscovery).toHaveBeenCalledTimes(2);
  });

  describe('before broadcast', () => {
    const subscribe = (service: IslockService) =>
      service.subscribeForInstantSendLock('txid', new Uint8Array([4]), { txid: 'prevout', vout: 0 });

    let warn: { mockRestore: () => void };
    beforeEach(() => {
      vi.useFakeTimers();
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.useRealTimers();
      warn.mockRestore();
    });

    it('retries a failed subscription, since nothing has been broadcast yet', async () => {
      const bytes = new Uint8Array([9]);
      mocks.subscribeForInstantSendLock
        .mockRejectedValueOnce(new Error('No mainnet evonodes found'))
        .mockRejectedValueOnce(new Error('3 nodes tried'))
        .mockResolvedValueOnce({ wait: vi.fn().mockResolvedValue(bytes) });
      const progress: string[] = [];
      const service = new IslockService({ network: 'mainnet' });

      const pending = service.subscribeForInstantSendLock(
        'txid', new Uint8Array([4]), { txid: 'prevout', vout: 0 }, 60000, undefined, (m) => progress.push(m)
      );
      await vi.advanceTimersByTimeAsync(PRE_BROADCAST_RETRY_DELAYS_MS[0] + PRE_BROADCAST_RETRY_DELAYS_MS[1]);
      const handle = await pending;

      expect(mocks.subscribeForInstantSendLock).toHaveBeenCalledTimes(3);
      expect(progress).toContain('Could not reach Dash evonodes, retrying...');
      await expect(handle.wait()).resolves.toBe(bytes);
    });

    it('says the deposit is unspent when every attempt fails', async () => {
      mocks.subscribeForInstantSendLock.mockRejectedValue(new Error('No mainnet evonodes found'));
      const pending = subscribe(new IslockService({ network: 'mainnet' }));
      const outcome = expect(pending).rejects.toThrow(/No mainnet evonodes found\. Nothing was broadcast, so your deposit has not been spent/);

      await vi.advanceTimersByTimeAsync(PRE_BROADCAST_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
      await outcome;
      expect(mocks.subscribeForInstantSendLock).toHaveBeenCalledTimes(PRE_BROADCAST_RETRY_DELAYS_MS.length + 1);
      // No tripwire poller is left running for a subscription that never existed.
      expect(mocks.getTransactionLockStatus).not.toHaveBeenCalled();
    });

    it('does not retry an aborted subscription', async () => {
      mocks.subscribeForInstantSendLock.mockRejectedValue(new Error('InstantSend lock subscription aborted for txid'));

      await expect(subscribe(new IslockService({ network: 'testnet' }))).rejects.toThrow(/aborted/);
      expect(mocks.subscribeForInstantSendLock).toHaveBeenCalledOnce();
    });

    it('stops waiting to retry when disconnected', async () => {
      mocks.subscribeForInstantSendLock.mockRejectedValue(new Error('3 nodes tried'));
      const service = new IslockService({ network: 'testnet' });
      const pending = subscribe(service);
      const outcome = expect(pending).rejects.toThrow('InstantSend lock subscription aborted for txid');

      await vi.advanceTimersByTimeAsync(100);
      await service.disconnect();
      await outcome;
      expect(mocks.subscribeForInstantSendLock).toHaveBeenCalledOnce();
    });
  });
});
