/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchPlatformStatus: vi.fn(),
  fetchPlatformStatusIfSdkReady: vi.fn(),
  dapiGetStatus: vi.fn(),
}));

vi.mock('../platform/status.js', () => ({
  fetchPlatformStatus: mocks.fetchPlatformStatus,
  fetchPlatformStatusIfSdkReady: mocks.fetchPlatformStatusIfSdkReady,
}));

vi.mock('@dashevo/dapi-client', () => {
  class FakeClient {
    platform = { getStatus: mocks.dapiGetStatus };
    core = {};
    disconnect = vi.fn(async () => {});
  }
  return { default: FakeClient };
});

vi.mock('@dashevo/dashcore-lib', () => ({ default: {} }));

import { DAPISubscriptionClient } from './dapi-subscription.js';
import { IslockService } from './islock.js';
import { fetchNetworkStatus } from './network-status.js';
import { TESTNET } from '../config.js';
import type { InsightClient } from './insight.js';

const insightAt = (height: number): InsightClient =>
  ({ getBlockHeight: async () => height }) as unknown as InsightClient;

const freshStatus = (overrides: Record<string, unknown> = {}) => ({
  coreChainLockedHeight: 1_578_100,
  latestBlockHeight: 80_000,
  latestBlockTimeMs: Date.now() - 4_000,
  ...overrides,
});

describe('Platform status routing', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy.mockRejectedValue(new Error('no network access expected'));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('DAPISubscriptionClient', () => {
    it('reads testnet status through the SDK, never dapi-client', async () => {
      // dapi-client's decoder throws on testnet nodes (no state_sync).
      mocks.dapiGetStatus.mockRejectedValue(
        new TypeError("Cannot read properties of undefined (reading 'getTotalSyncedTime')")
      );
      mocks.fetchPlatformStatus.mockResolvedValue(freshStatus());
      const client = new DAPISubscriptionClient({
        network: 'testnet',
        dapiAddresses: TESTNET.dapiAddresses,
      });

      await expect(client.getPlatformStatus()).resolves.toMatchObject({
        coreChainLockedHeight: 1_578_100,
        latestBlockHeight: 80_000,
      });
      await expect(client.getCoreChainLockedHeight()).resolves.toBe(1_578_100);
      expect(mocks.fetchPlatformStatus).toHaveBeenCalledWith('testnet');
      expect(mocks.dapiGetStatus).not.toHaveBeenCalled();
    });

    it('returns undefined chain-locked height when testnet reports none', async () => {
      mocks.fetchPlatformStatus.mockResolvedValue(freshStatus({ coreChainLockedHeight: undefined }));
      const client = new DAPISubscriptionClient({ network: 'testnet' });

      await expect(client.getCoreChainLockedHeight()).resolves.toBeUndefined();
    });

    it('routes by config type, so an unknown name that falls back to testnet uses the SDK', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mocks.fetchPlatformStatus.mockResolvedValue(freshStatus());
      const client = new DAPISubscriptionClient({ network: 'Testnet' });

      await expect(client.getCoreChainLockedHeight()).resolves.toBe(1_578_100);
      expect(mocks.dapiGetStatus).not.toHaveBeenCalled();
    });

    it('keeps the dapi-client call on devnets', async () => {
      mocks.dapiGetStatus.mockResolvedValue({
        chain: { coreChainLockedHeight: 4321, latestBlockHeight: 99n },
        time: { block: 1_700_000_000_000n },
      });
      const client = new DAPISubscriptionClient({
        network: 'devnet-moutai',
        dapiAddresses: ['https://68.67.122.254:1443'],
      });

      await expect(client.getPlatformStatus()).resolves.toEqual({
        coreChainLockedHeight: 4321,
        latestBlockHeight: 99,
        latestBlockTimeMs: 1_700_000_000_000,
      });
      expect(mocks.fetchPlatformStatus).not.toHaveBeenCalled();
    });

    it('keeps the dapi-client call on mainnet', async () => {
      mocks.dapiGetStatus.mockResolvedValue({ chain: { coreChainLockedHeight: 5 } });
      const client = new DAPISubscriptionClient({ network: 'mainnet' });

      await expect(client.getCoreChainLockedHeight()).resolves.toBe(5);
      expect(mocks.fetchPlatformStatus).not.toHaveBeenCalled();
    });
  });

  describe('network status on testnet', () => {
    const testnetIslock = () =>
      new IslockService({ network: 'testnet', dapiAddresses: TESTNET.dapiAddresses });

    it('uses the DAPI/SDK path, not JSON-RPC', () => {
      expect(testnetIslock().supportsJsonRpc).toBe(false);
    });

    it('reports healthy when the SDK call succeeds', async () => {
      mocks.fetchPlatformStatusIfSdkReady.mockResolvedValue(freshStatus());

      const status = await fetchNetworkStatus(insightAt(1_578_102), testnetIslock());

      expect(status.health).toBe('healthy');
      expect(status.reasons).toEqual([]);
      expect(status.coreChainLockedHeight).toBe(1_578_100);
      expect(status.platformBlockHeight).toBe(80_000);
      expect(status.platformBlockAgeMs).toBeLessThan(60_000);
      expect(mocks.fetchPlatformStatusIfSdkReady).toHaveBeenCalledWith('testnet');
      expect(mocks.dapiGetStatus).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('never triggers the SDK download: without a connected SDK it judges Core alone', async () => {
      mocks.fetchPlatformStatusIfSdkReady.mockResolvedValue(undefined);

      const status = await fetchNetworkStatus(insightAt(1_578_102), testnetIslock());

      expect(status.health).toBe('healthy');
      expect(status.reasons).toEqual([]);
      expect(status.coreHeight).toBe(1_578_102);
      expect(status.platformBlockHeight).toBeUndefined();
      // The loading variant is what would pull the SDK in; the poll must not use it.
      expect(mocks.fetchPlatformStatus).not.toHaveBeenCalled();
      expect(mocks.dapiGetStatus).not.toHaveBeenCalled();
    });

    it('reports degraded only when the SDK call fails', async () => {
      mocks.fetchPlatformStatusIfSdkReady.mockRejectedValue(
        new Error('Timed out while reading Platform status')
      );

      const status = await fetchNetworkStatus(insightAt(1_578_102), testnetIslock());

      expect(status.health).toBe('degraded');
      expect(status.reasons).toEqual(['Platform (DAPI) status unreachable']);
    });

    it('lets the chain-lock fallback load the SDK, since the user is mid-flow', async () => {
      mocks.fetchPlatformStatus.mockResolvedValue(freshStatus());

      await expect(testnetIslock().getCoreChainLockedHeight()).resolves.toBe(1_578_100);
      expect(mocks.fetchPlatformStatus).toHaveBeenCalledWith('testnet');
    });
  });

  it('peeks devnet status through dapi-client with no SDK involved', async () => {
    mocks.dapiGetStatus.mockResolvedValue({ chain: { coreChainLockedHeight: 7 } });
    const client = new DAPISubscriptionClient({
      network: 'devnet-moutai',
      dapiAddresses: ['https://68.67.122.254:1443'],
    });

    await expect(client.peekPlatformStatus()).resolves.toMatchObject({ coreChainLockedHeight: 7 });
    expect(mocks.fetchPlatformStatus).not.toHaveBeenCalled();
    expect(mocks.fetchPlatformStatusIfSdkReady).not.toHaveBeenCalled();
  });
});
