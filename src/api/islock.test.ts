import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  status: vi.fn(),
  lockStatus: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('./dapi-subscription.js', () => ({
  DAPISubscriptionClient: vi.fn().mockImplementation(() => ({
    subscribeForInstantSendLock: mocks.subscribe,
    getPlatformStatus: mocks.status,
    getTransactionLockStatus: mocks.lockStatus,
    disconnect: mocks.disconnect,
  })),
}));
import { IslockService } from './islock.js';

describe('IslockService', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  beforeEach(() => { mocks.lockStatus.mockResolvedValue(null); });
  it('opens a DAPI stream before the caller broadcasts', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    mocks.subscribe.mockResolvedValue({ wait: vi.fn().mockResolvedValue(bytes) });
    const service = new IslockService({ network: 'mainnet' });
    const handle = await service.subscribeForInstantSendLock('txid', new Uint8Array([4]), { txid: 'prev', vout: 0 });
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    await expect(handle.wait()).resolves.toBe(bytes);
  });
  it('reads chain-lock status through DAPI Platform', async () => {
    mocks.status.mockResolvedValue({ coreChainLockedHeight: 123 });
    const service = new IslockService({ network: 'testnet' });
    await expect(service.getCoreChainLockedHeight()).resolves.toBe(123);
  });
});
