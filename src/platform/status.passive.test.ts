import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isPlatformSdkSettled: vi.fn(),
  loadSdk: vi.fn(),
  status: vi.fn(),
}));

// Fake the client module wholesale: what matters here is that the passive
// reader never calls into anything that would load or connect the SDK.
vi.mock('./client.js', () => ({
  isPlatformSdkSettled: mocks.isPlatformSdkSettled,
  withConnectedPlatformSdk: async (_network: string, callback: (sdk: unknown) => Promise<unknown>) => {
    mocks.loadSdk();
    return callback({ system: { status: mocks.status } });
  },
  withPlatformOperationTimeout: <T>(promise: Promise<T>) => promise,
}));

import { fetchPlatformStatusIfSdkReady } from './status.js';

describe('fetchPlatformStatusIfSdkReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status.mockResolvedValue({
      chain: { core_chain_locked_height: 1_578_300, latest_block_height: '642000' },
      time: { block: '1792000000000' },
    });
  });

  it('resolves undefined without touching the SDK while nothing has started connecting it or the first connect is in flight', async () => {
    mocks.isPlatformSdkSettled.mockReturnValue(false);

    await expect(fetchPlatformStatusIfSdkReady('testnet')).resolves.toBeUndefined();

    expect(mocks.isPlatformSdkSettled).toHaveBeenCalledWith('testnet');
    expect(mocks.loadSdk).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('reads the status once a connect has settled', async () => {
    mocks.isPlatformSdkSettled.mockReturnValue(true);

    await expect(fetchPlatformStatusIfSdkReady('testnet')).resolves.toEqual({
      coreChainLockedHeight: 1_578_300,
      latestBlockHeight: 642000,
      latestBlockTimeMs: 1_792_000_000_000,
    });
    expect(mocks.status).toHaveBeenCalledOnce();
  });
});
