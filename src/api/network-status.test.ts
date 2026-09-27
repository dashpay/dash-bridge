import { describe, it, expect } from 'vitest';
import { fetchNetworkStatus, formatAge } from './network-status.js';
import type { CoreClient } from './core.js';
import type { IslockService } from './islock.js';

type PlatformStatus = Awaited<ReturnType<IslockService['getPlatformStatus']>>;
function makeClients(coreHeight: number | Error, platform: PlatformStatus | Error) {
  const core = { getBlockHeight: async () => { if (coreHeight instanceof Error) throw coreHeight; return coreHeight; } } as unknown as CoreClient;
  const islock = { getPlatformStatus: async () => { if (platform instanceof Error) throw platform; return platform; } } as unknown as IslockService;
  return { core, islock };
}
const fresh = () => Date.now() - 5_000;

describe('fetchNetworkStatus', () => {
  it('reports healthy when DAPI Core and Platform are in lock-step', async () => {
    const { core, islock } = makeClients(10_700, { coreChainLockedHeight: 10_698, latestBlockHeight: 5_000, latestBlockTimeMs: fresh() });
    const status = await fetchNetworkStatus(core, islock);
    expect(status.health).toBe('healthy');
    expect(status.chainLockLag).toBe(2);
  });
  it('reports a stalled chain lock', async () => {
    const { core, islock } = makeClients(10_700, { coreChainLockedHeight: 10_650, latestBlockHeight: 5_000, latestBlockTimeMs: fresh() });
    const status = await fetchNetworkStatus(core, islock);
    expect(status.health).toBe('stalled');
    expect(status.chainLockLag).toBe(50);
  });
  it('reports unknown when both DAPI surfaces fail', async () => {
    const { core, islock } = makeClients(new Error('core down'), new Error('platform down'));
    const status = await fetchNetworkStatus(core, islock);
    expect(status.health).toBe('unknown');
  });
});

describe('formatAge', () => {
  it('formats compact ages', () => {
    expect(formatAge(30_000)).toBe('<1m');
    expect(formatAge(12 * 60_000)).toBe('12m');
    expect(formatAge(3 * 60 * 60_000 + 5 * 60_000)).toBe('3h 5m');
  });
});
