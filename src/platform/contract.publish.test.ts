import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  publish: vi.fn(),
  fromJSON: vi.fn(),
  latest: vi.fn(),
}));

vi.mock('./client.js', () => ({
  withConnectedPlatformSdk: async (_network: string, callback: (sdk: unknown) => Promise<unknown>) =>
    callback({ system: { status: mocks.status }, contracts: { publish: mocks.publish } }),
  fetchIdentityWithSdk: async () => ({ getPublicKeyById: () => ({ id: 1 }) }),
}));

vi.mock('./sdkModule.js', () => ({
  loadSdkModule: async () => ({
    IdentitySigner: class {
      addKeyFromWif() {}
    },
    DataContract: { fromJSON: mocks.fromJSON, generateId: () => 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec' },
    PlatformVersion: { latest: mocks.latest },
  }),
}));

import { publishContract } from './contract.js';

const OWNER_ID = '2ZqDG9z97YZrhA3UuuoLfk4b4XQdaMgTUowS7hTw6wGK';
const CONTRACT = { note: { type: 'object', properties: {}, additionalProperties: false } };

function statusAt(current: unknown) {
  return { toJSON: () => ({ version: { protocol: { drive: { latest: 15, current } } } }) };
}

describe('publishContract platform version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.latest.mockReturnValue(15);
    mocks.fromJSON.mockReturnValue({ contract: true });
    mocks.publish.mockResolvedValue({ id: { toString: () => 'contract-id' } });
  });

  it.each([14, 15])('builds the contract at the network protocol version %i, not latest()', async (current) => {
    mocks.status.mockResolvedValue(statusAt(current));

    await expect(publishContract(OWNER_ID, CONTRACT, 1, 'wif', 'mainnet')).resolves.toEqual({ contractId: 'contract-id' });

    expect(mocks.fromJSON).toHaveBeenCalledWith(expect.anything(), true, current);
    expect(mocks.latest).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ dataContract: { contract: true } }));
  });

  it.each([undefined, null, '14', 0, 14.5])('refuses to publish when the network reports protocol version %s', async (current) => {
    mocks.status.mockResolvedValue(statusAt(current));

    await expect(publishContract(OWNER_ID, CONTRACT, 1, 'wif', 'mainnet', { maxAttempts: 1 }))
      .rejects.toThrow('Could not read the network protocol version');

    expect(mocks.fromJSON).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
