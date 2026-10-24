import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const sdkState = vi.hoisted(() => ({
  created: 0,
  connect: vi.fn(),
}));

vi.mock('./sdkModule.js', () => ({
  loadSdkModule: async () => ({
    EvoSDK: {
      testnetTrusted: () => {
        sdkState.created++;
        const sdk = {
          isConnected: false,
          connect: async () => {
            await sdkState.connect();
            sdk.isConnected = true;
          },
        };
        return sdk;
      },
    },
  }),
}));

describe('connectPlatformSdk', () => {
  let connectPlatformSdk: typeof import('./client.js').connectPlatformSdk;

  beforeEach(async () => {
    // The SDK cache is module state; start each test from an empty one.
    vi.resetModules();
    ({ connectPlatformSdk } = await import('./client.js'));
    sdkState.created = 0;
    sdkState.connect.mockReset();
    sdkState.connect.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shares one SDK between concurrent callers', async () => {
    const [a, b, c] = await Promise.all([
      connectPlatformSdk('testnet', { maxAttempts: 1 }),
      connectPlatformSdk('testnet', { maxAttempts: 1 }),
      connectPlatformSdk('testnet', { maxAttempts: 1 }),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(sdkState.created).toBe(1);
    expect(sdkState.connect).toHaveBeenCalledOnce();
  });

  it('reuses the connected SDK on later calls', async () => {
    const first = await connectPlatformSdk('testnet', { maxAttempts: 1 });
    const second = await connectPlatformSdk('testnet', { maxAttempts: 1 });

    expect(second).toBe(first);
    expect(sdkState.created).toBe(1);
  });

  it('lets the next caller retry after a failed connect', async () => {
    sdkState.connect.mockRejectedValueOnce(new Error('connect failed'));

    const failed = await Promise.allSettled([
      connectPlatformSdk('testnet', { maxAttempts: 1 }),
      connectPlatformSdk('testnet', { maxAttempts: 1 }),
    ]);
    expect(failed.map((r) => r.status)).toEqual(['rejected', 'rejected']);

    await expect(connectPlatformSdk('testnet', { maxAttempts: 1 })).resolves.toBeDefined();
    expect(sdkState.created).toBe(2);
  });
});
