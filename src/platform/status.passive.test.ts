import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasConnectedPlatformSdk: vi.fn(),
  loadSdk: vi.fn(),
  status: vi.fn(),
}));

// Fake the client module wholesale: what matters here is that the passive
// reader never calls into anything that would load or connect the SDK.
vi.mock('./client.js', () => ({
  hasConnectedPlatformSdk: mocks.hasConnectedPlatformSdk,
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

  it('resolves undefined without touching the SDK while it is not connected', async () => {
    mocks.hasConnectedPlatformSdk.mockReturnValue(false);

    await expect(fetchPlatformStatusIfSdkReady('testnet')).resolves.toBeUndefined();

    expect(mocks.hasConnectedPlatformSdk).toHaveBeenCalledWith('testnet');
    expect(mocks.loadSdk).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('reads the status once the SDK is already connected', async () => {
    mocks.hasConnectedPlatformSdk.mockReturnValue(true);

    await expect(fetchPlatformStatusIfSdkReady('testnet')).resolves.toEqual({
      coreChainLockedHeight: 1_578_300,
      latestBlockHeight: 642000,
      latestBlockTimeMs: 1_792_000_000_000,
    });
    expect(mocks.status).toHaveBeenCalledOnce();
  });
});
