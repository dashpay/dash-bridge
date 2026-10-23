// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdkState = vi.hoisted(() => ({
  status: vi.fn(),
  connect: vi.fn(async () => {}),
  created: 0,
}));

// Exercise the real client helpers (connect, timeout) against a fake SDK.
vi.mock('./sdkModule.js', () => ({
  loadSdkModule: async () => ({
    EvoSDK: {
      testnetTrusted: () => {
        sdkState.created++;
        return {
          isConnected: false,
          connect: sdkState.connect,
          system: { status: sdkState.status },
        };
      },
    },
  }),
}));

import { fetchPlatformStatus } from './status.js';
import { PlatformOperationTimeoutError } from './client.js';

function status(overrides: {
  chain?: Record<string, unknown>;
  time?: Record<string, unknown>;
} = {}) {
  return {
    chain: {
      core_chain_locked_height: 1_578_123,
      latest_block_height: '77001',
      ...overrides.chain,
    },
    time: { block: '1792000000000', local: '1792000000', ...overrides.time },
  };
}

describe('fetchPlatformStatus', () => {
  beforeEach(() => {
    sdkState.status.mockReset();
    sdkState.connect.mockClear();
    sdkState.created = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('maps the snake_case SDK fields', async () => {
    sdkState.status.mockResolvedValue(status());

    await expect(fetchPlatformStatus('testnet')).resolves.toEqual({
      coreChainLockedHeight: 1_578_123,
      latestBlockHeight: 77001,
      latestBlockTimeMs: 1_792_000_000_000,
    });
    expect(sdkState.connect).toHaveBeenCalledOnce();
  });

  it('accepts bigint values', async () => {
    sdkState.status.mockResolvedValue(
      status({
        chain: { core_chain_locked_height: 1_578_124n, latest_block_height: 77002n },
        time: { block: 1_792_000_001_000n },
      })
    );

    await expect(fetchPlatformStatus('testnet')).resolves.toEqual({
      coreChainLockedHeight: 1_578_124,
      latestBlockHeight: 77002,
      latestBlockTimeMs: 1_792_000_001_000,
    });
  });

  it('reports missing, zero and malformed values as undefined', async () => {
    sdkState.status.mockResolvedValue(
      status({
        chain: { core_chain_locked_height: undefined, latest_block_height: '0' },
        time: { block: '' },
      })
    );
    await expect(fetchPlatformStatus('testnet')).resolves.toEqual({
      coreChainLockedHeight: undefined,
      latestBlockHeight: undefined,
      latestBlockTimeMs: undefined,
    });

    sdkState.status.mockResolvedValue(
      status({
        chain: { core_chain_locked_height: 0, latest_block_height: 'abc' },
        time: { block: null },
      })
    );
    await expect(fetchPlatformStatus('testnet')).resolves.toEqual({
      coreChainLockedHeight: undefined,
      latestBlockHeight: undefined,
      latestBlockTimeMs: undefined,
    });
  });

  it('tolerates a status without chain or time sections', async () => {
    sdkState.status.mockResolvedValue({});

    await expect(fetchPlatformStatus('testnet')).resolves.toEqual({
      coreChainLockedHeight: undefined,
      latestBlockHeight: undefined,
      latestBlockTimeMs: undefined,
    });
  });

  it('propagates SDK failures', async () => {
    sdkState.status.mockRejectedValue(new Error('boom'));

    await expect(fetchPlatformStatus('testnet')).rejects.toThrow('boom');
  });

  it('times out when the SDK call never settles', async () => {
    vi.useFakeTimers();
    sdkState.status.mockReturnValue(new Promise(() => {}));

    const result = fetchPlatformStatus('testnet');
    const assertion = expect(result).rejects.toBeInstanceOf(PlatformOperationTimeoutError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });
});
