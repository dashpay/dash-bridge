// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  created: [] as string[],
  connect: vi.fn(),
  status: vi.fn(),
}));

// Real client/status/loaders modules against a fake SDK, so the eviction path
// in withConnectedPlatformSdk is exercised for real.
vi.mock('./sdkModule.js', () => {
  const make = (kind: string) => () => {
    sdk.created.push(kind);
    const instance = {
      isConnected: false,
      connect: async () => {
        await sdk.connect();
        instance.isConnected = true;
      },
      system: { status: () => sdk.status() },
    };
    return instance;
  };
  return {
    loadSdkModule: async () => ({
      EvoSDK: {
        testnetTrusted: make('testnet'),
        mainnetTrusted: make('mainnet'),
        devnetTrusted: make('devnet-trusted'),
        devnet: make('devnet'),
      },
    }),
  };
});

const goodStatus = (overrides: { clh?: number } = {}) => ({
  chain: { core_chain_locked_height: overrides.clh ?? 1_578_100, latest_block_height: '80000' },
  time: { block: String(Date.now() - 4_000) },
});

const insight = (height: number) => ({ getBlockHeight: async () => height }) as never;

describe('Platform status across an SDK session', () => {
  let fetchPlatformStatusIfSdkReady: typeof import('./status.js').fetchPlatformStatusIfSdkReady;
  let warmPlatformSdkForFunding: typeof import('./loaders.js').warmPlatformSdkForFunding;
  let fetchNetworkStatus: typeof import('../api/network-status.js').fetchNetworkStatus;

  const testnetStatus = () =>
    fetchNetworkStatus(insight(1_578_102), {
      supportsJsonRpc: false,
      peekPlatformStatus: () => fetchPlatformStatusIfSdkReady('testnet'),
    } as never);

  beforeEach(async () => {
    vi.resetModules(); // fresh SDK cache and loader cache per test
    ({ fetchPlatformStatusIfSdkReady } = await import('./status.js'));
    ({ warmPlatformSdkForFunding } = await import('./loaders.js'));
    ({ fetchNetworkStatus } = await import('../api/network-status.js'));
    sdk.created.length = 0;
    sdk.connect.mockReset();
    sdk.connect.mockResolvedValue(undefined);
    sdk.status.mockReset();
    sdk.status.mockResolvedValue(goodStatus());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads no SDK on an idle page: the poll reports Core only and never connects', async () => {
    const result = await testnetStatus();
    await testnetStatus();

    expect(result.health).toBe('healthy');
    expect(result.platformChecked).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(sdk.created).toEqual([]);
    expect(sdk.status).not.toHaveBeenCalled();
  });

  describe('warmPlatformSdkForFunding', () => {
    it('connects the testnet SDK when a funding flow starts', async () => {
      await expect(warmPlatformSdkForFunding('testnet')).resolves.toBe(true);

      expect(sdk.created).toEqual(['testnet']);
      expect(sdk.connect).toHaveBeenCalledOnce();
    });

    it.each(['mainnet', 'devnet-moutai'])('does nothing on %s', async (network) => {
      await expect(warmPlatformSdkForFunding(network)).resolves.toBe(false);

      expect(sdk.created).toEqual([]);
      expect(sdk.connect).not.toHaveBeenCalled();
    });

    it('shares one connect between repeated and concurrent funding starts', async () => {
      await Promise.all([
        warmPlatformSdkForFunding('testnet'),
        warmPlatformSdkForFunding('testnet'),
      ]);
      await warmPlatformSdkForFunding('testnet');

      expect(sdk.created).toEqual(['testnet']);
    });

    it('never rejects when the connect fails, and the failure then shows as degraded', async () => {
      sdk.connect.mockRejectedValue(new Error('quorums unreachable'));

      await expect(warmPlatformSdkForFunding('testnet')).resolves.toBe(true);

      const result = await testnetStatus(); // retries the connect, which still fails
      expect(result.health).toBe('degraded');
      expect(result.reasons).toEqual(['Platform (DAPI) status unreachable']);
    });
  });

  it('keeps the Core-only wording while the SDK is still connecting, then reads Platform', async () => {
    let finishConnect!: () => void;
    sdk.connect.mockReturnValue(new Promise<void>((resolve) => (finishConnect = resolve)));

    const warming = warmPlatformSdkForFunding('testnet');
    await vi.waitFor(() => expect(sdk.connect).toHaveBeenCalled());

    const connecting = await testnetStatus();
    expect(connecting.health).toBe('healthy');
    expect(connecting.platformChecked).toBe(false);
    expect(sdk.status).not.toHaveBeenCalled();

    finishConnect();
    await warming;

    const connected = await testnetStatus();
    expect(connected.health).toBe('healthy');
    expect(connected.platformChecked).toBeUndefined();
    expect(connected.platformBlockHeight).toBe(80_000);
    expect(connected.coreChainLockedHeight).toBe(1_578_100);
  });

  it('turns degraded when a connected SDK stops answering, and recovers when it answers again', async () => {
    await warmPlatformSdkForFunding('testnet');
    expect((await testnetStatus()).platformChecked).toBeUndefined();

    // A connection error evicts the cached SDK (withConnectedPlatformSdk). The
    // next poll must not fall back to Core-only "healthy" because of that.
    sdk.status.mockRejectedValueOnce(new Error('transport error: connection refused'));
    const failing = await testnetStatus();
    expect(failing.health).toBe('degraded');
    expect(failing.reasons).toEqual(['Platform (DAPI) status unreachable']);

    sdk.status.mockRejectedValueOnce(new Error('transport error: connection refused'));
    const stillFailing = await testnetStatus();
    expect(stillFailing.health).toBe('degraded');
    expect(stillFailing.platformChecked).toBeUndefined();

    // Platform is back: the poll reconnects through the already loaded module.
    const recovered = await testnetStatus();
    expect(recovered.health).toBe('healthy');
    expect(recovered.reasons).toEqual([]);
    expect(recovered.platformBlockHeight).toBe(80_000);
    expect(sdk.created.every((kind) => kind === 'testnet')).toBe(true);
    // The connection errors really evicted the cached SDK: each recovery reconnected.
    expect(sdk.created.length).toBeGreaterThan(1);
  });

  it('also degrades on a timeout-style failure of a connected SDK (no eviction)', async () => {
    await warmPlatformSdkForFunding('testnet');
    sdk.status.mockRejectedValueOnce(new Error('Timed out while reading Platform status'));

    const failing = await testnetStatus();

    expect(failing.health).toBe('degraded');
    expect((await testnetStatus()).health).toBe('healthy');
    expect(sdk.created).toEqual(['testnet']); // a timeout does not evict the SDK
  });

  it('does not flap back to healthy while a reconnect after an outage is still pending', async () => {
    vi.useFakeTimers();
    try {
      await warmPlatformSdkForFunding('testnet');
      sdk.status.mockRejectedValueOnce(new Error('transport error: connection refused'));
      expect((await testnetStatus()).health).toBe('degraded'); // evicts the SDK

      // The reconnect started by the next poll never finishes.
      sdk.connect.mockReturnValue(new Promise<void>(() => {}));
      const second = testnetStatus();
      await vi.advanceTimersByTimeAsync(20_000); // the poll's own timeout
      const secondResult = await second;
      expect(secondResult.health).toBe('degraded');

      // The next poll joins that same pending connect: still degraded, not "not read yet".
      const third = testnetStatus();
      await vi.advanceTimersByTimeAsync(20_000);
      const thirdResult = await third;
      expect(thirdResult.health).toBe('degraded');
      expect(thirdResult.platformChecked).toBeUndefined();
      expect(sdk.created.length).toBe(2); // one reconnect, shared
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns a hung first connect into degraded once the grace period has passed', async () => {
    vi.useFakeTimers();
    try {
      sdk.connect.mockReturnValue(new Promise<void>(() => {}));
      void warmPlatformSdkForFunding('testnet');
      await vi.advanceTimersByTimeAsync(0);

      const early = await testnetStatus();
      expect(early.health).toBe('healthy');
      expect(early.platformChecked).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      const late = testnetStatus();
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await late).health).toBe('degraded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still flags a genuinely stalled Platform once connected', async () => {
    await warmPlatformSdkForFunding('testnet');
    sdk.status.mockResolvedValue(goodStatus({ clh: 1_577_000 }));

    const result = await testnetStatus();

    expect(result.health).toBe('stalled');
  });
});
