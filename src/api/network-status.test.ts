import { describe, it, expect } from 'vitest';

import { fetchNetworkStatus, formatAge } from './network-status.js';
import type { InsightClient } from './insight.js';
import type { IslockService } from './islock.js';

type PlatformStatus = Awaited<ReturnType<IslockService['getPlatformStatus']>>;
type ChainLock = Awaited<ReturnType<IslockService['getBestChainLock']>>;

/**
 * Build stub clients. `platform` selects the DAPI path (devnet:
 * supportsJsonRpc=false); `chainLock` selects the JSON-RPC path
 * (mainnet/testnet: supportsJsonRpc=true).
 */
function makeClients(opts: {
  coreHeight?: number | Error;
  platform?: PlatformStatus | Error;
  chainLock?: ChainLock | Error;
}): { insight: InsightClient; islock: IslockService } {
  const insight = {
    getBlockHeight: async () => {
      if (opts.coreHeight instanceof Error) throw opts.coreHeight;
      if (opts.coreHeight === undefined) throw new Error('no core height');
      return opts.coreHeight;
    },
  } as unknown as InsightClient;

  const useJsonRpc = opts.chainLock !== undefined;

  const islock = {
    supportsJsonRpc: useJsonRpc,
    getBestChainLock: async () => {
      if (opts.chainLock instanceof Error) throw opts.chainLock;
      return opts.chainLock ?? null;
    },
    getPlatformStatus: async () => {
      if (opts.platform instanceof Error) throw opts.platform;
      if (opts.platform === undefined) throw new Error('no platform status');
      return opts.platform;
    },
  } as unknown as IslockService;

  return { insight, islock };
}

const freshBlock = (): number => Date.now() - 5_000; // 5s old

describe('fetchNetworkStatus (DAPI / devnet path)', () => {
  it('reports healthy when Core and Platform are in lock-step', async () => {
    const { insight, islock } = makeClients({
      coreHeight: 10_700,
      platform: {
        coreChainLockedHeight: 10_698,
        latestBlockHeight: 5_000,
        latestBlockTimeMs: freshBlock(),
      },
    });

    const status = await fetchNetworkStatus(insight, islock);
    expect(status.health).toBe('healthy');
    expect(status.chainLockLag).toBe(2);
    expect(status.reasons).toHaveLength(0);
  });

  it('flags stalled when chain-lock lags Core far behind', async () => {
    const { insight, islock } = makeClients({
      coreHeight: 10_700,
      platform: {
        coreChainLockedHeight: 9_755, // ~945 blocks behind
        latestBlockHeight: 402,
        latestBlockTimeMs: freshBlock(),
      },
    });

    const status = await fetchNetworkStatus(insight, islock);
    expect(status.health).toBe('stalled');
    expect(status.chainLockLag).toBe(945);
    expect(status.reasons.join(' ')).toMatch(/chain-lock/i);
  });

  it('flags stalled on an ancient Platform block even when chain-lock is current', async () => {
    const { insight, islock } = makeClients({
      coreHeight: 10_700,
      platform: {
        coreChainLockedHeight: 10_699,
        latestBlockHeight: 402,
        latestBlockTimeMs: Date.now() - 60 * 60_000, // 1h old
      },
    });

    const status = await fetchNetworkStatus(insight, islock);
    expect(status.health).toBe('stalled');
    expect(status.reasons.join(' ')).toMatch(/Platform block/i);
  });

  it('flags degraded for a mild chain-lock lag', async () => {
    const { insight, islock } = makeClients({
      coreHeight: 10_700,
      platform: {
        coreChainLockedHeight: 10_688, // 12 behind → degraded, not stalled
        latestBlockHeight: 5_000,
        latestBlockTimeMs: freshBlock(),
      },
    });

    const status = await fetchNetworkStatus(insight, islock);
    expect(status.health).toBe('degraded');
    expect(status.chainLockLag).toBe(12);
  });

  it('marks Platform unreachable as degraded (not a false stall) when only Core responds', async () => {
    const { insight, islock } = makeClients({
      coreHeight: 10_700,
      platform: new Error('dapi down'),
    });

    const status = await fetchNetworkStatus(insight, islock);
    expect(status.health).toBe('degraded');
    expect(status.coreHeight).toBe(10_700);
    expect(status.reasons.join(' ')).toMatch(/Platform/i);
  });
});

describe('fetchNetworkStatus (JSON-RPC / mainnet-testnet path)', () => {
  it('reports healthy when Core chain-lock tracks the tip', async () => {
    const { insight, islock } = makeClients({
      coreHeight: 10_700,
      chainLock: { height: 10_699 },
    });

    const status = await fetchNetworkStatus(insight, islock);
    expect(status.health).toBe('healthy');
    expect(status.coreChainLockedHeight).toBe(10_699);
    expect(status.chainLockLag).toBe(1);
    // No Tenderdash block age signal on this path.
    expect(status.platformBlockHeight).toBeUndefined();
  });

  it('flags stalled when Core chain-lock falls far behind', async () => {
    const { insight, islock } = makeClients({
      coreHeight: 10_700,
      chainLock: { height: 10_650 }, // 50 behind
    });

    const status = await fetchNetworkStatus(insight, islock);
    expect(status.health).toBe('stalled');
    expect(status.chainLockLag).toBe(50);
  });

  it('stays healthy (no lag signal) when no chain lock observed yet', async () => {
    const { insight, islock } = makeClients({
      coreHeight: 10_700,
      chainLock: null,
    });

    const status = await fetchNetworkStatus(insight, islock);
    expect(status.health).toBe('healthy');
    expect(status.coreChainLockedHeight).toBeUndefined();
    expect(status.chainLockLag).toBeUndefined();
  });

  it('reports the RPC source (not Platform) when the chain-lock RPC fails', async () => {
    const { insight, islock } = makeClients({
      coreHeight: 10_700,
      chainLock: new Error('rpc down'),
    });

    const status = await fetchNetworkStatus(insight, islock);
    expect(status.health).toBe('degraded');
    expect(status.reasons.join(' ')).toMatch(/RPC/i);
    expect(status.reasons.join(' ')).not.toMatch(/Platform/i);
  });
});

describe('fetchNetworkStatus (both sources down)', () => {
  it('is unknown when neither Core nor the chain-lock source responds', async () => {
    const { insight, islock } = makeClients({
      coreHeight: new Error('insight down'),
      chainLock: new Error('rpc down'),
    });

    const status = await fetchNetworkStatus(insight, islock);
    expect(status.health).toBe('unknown');
  });
});

describe('formatAge', () => {
  it('formats sub-minute, minutes, and hours', () => {
    expect(formatAge(30_000)).toBe('<1m');
    expect(formatAge(12 * 60_000)).toBe('12m');
    expect(formatAge(3 * 60 * 60_000 + 5 * 60_000)).toBe('3h 5m');
    expect(formatAge(2 * 60 * 60_000)).toBe('2h');
  });
});
