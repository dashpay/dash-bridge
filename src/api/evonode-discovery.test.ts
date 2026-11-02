/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'node:events';
import cbor from 'cbor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A "masternode list" here is CBOR of { hosts: [...] }; the fake parser turns
// each host into a valid evonode on port 1443 ('bad' hosts make it throw).
vi.mock('@dashevo/dashcore-lib', () => {
  class SimplifiedMNListDiff {
    hosts: string[];
    constructor(obj: { hosts: string[] }, public network: string) {
      if (obj.hosts.includes('bad')) throw new Error('Failed to parse payload');
      this.hosts = obj.hosts;
    }
  }
  class SimplifiedMNList {
    constructor(private readonly diff: SimplifiedMNListDiff) {}
    getValidMasternodesList() {
      return this.diff.hosts.map((host) => ({ getPlatformHTTPSEndpoint: () => ({ host, port: 1443 }) }));
    }
  }
  return { default: { SimplifiedMNList, SimplifiedMNListDiff } };
});

import {
  EVONODE_LIST_MAX_AGE_MS,
  EvonodeDiscovery,
  MASTERNODE_LIST_TIMEOUT_MS,
  SEED_HEDGE_DELAY_MS,
  evonodeEndpointsFromSml,
  fetchEvonodesFromSeeds,
  parseDapiAddress,
  seedAddresses,
  type DapiAddress,
} from './evonode-discovery.js';

const listMessage = (...hosts: string[]) => ({ getMasternodeListDiff_asU8: () => new Uint8Array(cbor.encode({ hosts })) });

type Behaviour =
  | { kind: 'list'; hosts: string[] }
  | { kind: 'reject' }
  | { kind: 'error-end' }
  | { kind: 'silent' };

/** Fake dapi-client clients whose masternode list stream follows `behaviour[host]`. */
function fakeNetwork(behaviour: Record<string, Behaviour>) {
  const clients: any[] = [];
  const streams: any[] = [];
  const createClient = (addresses: DapiAddress[]) => {
    const host = addresses[0].host;
    const client: any = {
      addresses,
      disconnect: vi.fn(async () => {}),
      core: {
        subscribeToMasternodeList: vi.fn(async () => {
          const b = behaviour[host] ?? { kind: 'silent' };
          if (b.kind === 'reject') throw new Error(`UNAVAILABLE: Name resolution failed for ${host}`);
          const stream: any = new EventEmitter();
          stream.cancel = vi.fn();
          streams.push(stream);
          setTimeout(() => {
            if (b.kind === 'list') stream.emit('data', listMessage(...b.hosts));
            // Browser grpc-web: a failed stream reports through both channels.
            if (b.kind === 'error-end') {
              stream.emit('error', new Error('Response closed without headers'));
              stream.emit('end');
            }
          }, 100);
          return stream;
        }),
      },
    };
    clients.push(client);
    return client;
  };
  return { clients, streams, createClient };
}

const seeds = seedAddresses(['seed-1.test:1443', 'seed-2.test:1443', 'seed-3.test:1443']);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('address helpers', () => {
  it('parses seeds and URLs into the address objects dapi-client takes', () => {
    expect(seedAddresses(['seed-1.testnet.networks.dash.org:1443'])).toEqual([
      { protocol: 'https', host: 'seed-1.testnet.networks.dash.org', port: 1443 },
    ]);
    expect(parseDapiAddress('https://evo.example.org')).toEqual({ protocol: 'https', host: 'evo.example.org', port: 443 });
  });

  it('keeps valid evonode endpoints from a list, without duplicates or unusable hosts', () => {
    const entry = (endpoint: unknown) => ({ getPlatformHTTPSEndpoint: () => endpoint });
    const sml = {
      getValidMasternodesList: () => [
        entry({ host: '68.67.122.1', port: 1443 }),
        entry(null), // regular masternode
        entry({ host: '68.67.122.1', port: 1443 }),
        entry({ host: '2001:db8::1', port: 1443 }),
        entry({ host: 'evo.example.org', port: 2443 }),
        {},
        null,
      ],
    };

    expect(evonodeEndpointsFromSml(sml)).toEqual(['https://68.67.122.1:1443', 'https://evo.example.org:2443']);
    expect(evonodeEndpointsFromSml(undefined)).toEqual([]);
  });
});

describe('fetchEvonodesFromSeeds', () => {
  it('reads the list from the first seed and closes its stream and client', async () => {
    const net = fakeNetwork({ 'seed-1.test': { kind: 'list', hosts: ['10.0.0.1', '10.0.0.2'] } });

    const result = fetchEvonodesFromSeeds(seeds, (seed) => net.createClient([seed]), 'testnet');
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual(['https://10.0.0.1:1443', 'https://10.0.0.2:1443']);
    expect(net.clients).toHaveLength(1);
    expect(net.streams[0].cancel).toHaveBeenCalled();
    expect(net.clients[0].disconnect).toHaveBeenCalled();
    expect(net.clients[0].core.subscribeToMasternodeList).toHaveBeenCalledWith({ retries: 0 });
  });

  it.each(['reject', 'error-end'] as const)('moves to the next seed at once when a seed fails (%s)', async (kind) => {
    const net = fakeNetwork({
      'seed-1.test': { kind },
      'seed-2.test': { kind: 'list', hosts: ['10.0.0.5'] },
    });

    const result = fetchEvonodesFromSeeds(seeds, (seed) => net.createClient([seed]), 'testnet');
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual(['https://10.0.0.5:1443']);
    expect(net.clients.map((c) => c.addresses[0].host)).toEqual(['seed-1.test', 'seed-2.test']);
  });

  it('treats a list it cannot parse as a failed seed', async () => {
    const net = fakeNetwork({
      'seed-1.test': { kind: 'list', hosts: ['bad'] },
      'seed-2.test': { kind: 'list', hosts: ['10.0.0.5'] },
    });

    const result = fetchEvonodesFromSeeds(seeds, (seed) => net.createClient([seed]), 'testnet');
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual(['https://10.0.0.5:1443']);
  });

  it(`asks the next seed too when one is silent for ${SEED_HEDGE_DELAY_MS} ms, and cancels the slow one`, async () => {
    const net = fakeNetwork({
      'seed-1.test': { kind: 'silent' },
      'seed-2.test': { kind: 'list', hosts: ['10.0.0.5'] },
    });

    const result = fetchEvonodesFromSeeds(seeds, (seed) => net.createClient([seed]), 'testnet');
    await vi.advanceTimersByTimeAsync(SEED_HEDGE_DELAY_MS - 1);
    expect(net.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(101);

    await expect(result).resolves.toEqual(['https://10.0.0.5:1443']);
    expect(net.streams[0].cancel).toHaveBeenCalled();
    expect(net.clients[0].disconnect).toHaveBeenCalled();
  });

  it('rejects once every seed failed', async () => {
    const failing = fakeNetwork({
      'seed-1.test': { kind: 'reject' },
      'seed-2.test': { kind: 'error-end' },
      'seed-3.test': { kind: 'reject' },
    });

    const result = fetchEvonodesFromSeeds(seeds, (seed) => failing.createClient([seed]), 'testnet');
    const assertion = expect(result).rejects.toThrow(/3 seeds tried/);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(failing.clients).toHaveLength(3);
  });

  it(`rejects after ${MASTERNODE_LIST_TIMEOUT_MS} ms and closes every stream`, async () => {
    const net = fakeNetwork({});

    const result = fetchEvonodesFromSeeds(seeds, (seed) => net.createClient([seed]), 'testnet');
    const assertion = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(MASTERNODE_LIST_TIMEOUT_MS);
    await assertion;

    expect(net.streams).toHaveLength(3);
    for (const stream of net.streams) expect(stream.cancel).toHaveBeenCalled();
    for (const client of net.clients) expect(client.disconnect).toHaveBeenCalled();
  });

  it('rejects at once on abort and closes the open stream', async () => {
    const net = fakeNetwork({});
    const controller = new AbortController();

    const result = fetchEvonodesFromSeeds(seeds, (seed) => net.createClient([seed]), 'testnet', controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();

    await expect(result).rejects.toThrow(/aborted/);
    expect(net.streams[0].cancel).toHaveBeenCalled();
  });
});

describe('EvonodeDiscovery', () => {
  const fallback = vi.fn<[], Promise<string[]>>();
  let now = 0;
  const discover = (behaviour: Record<string, Behaviour>) => {
    const net = fakeNetwork(behaviour);
    const discovery = new EvonodeDiscovery({
      network: 'testnet',
      seeds: seeds.slice(0, 1),
      createClient: net.createClient,
      fetchFallback: fallback,
      now: () => now,
    });
    const seedClients = () => net.clients.filter((c) => c.addresses[0].host.startsWith('seed-'));
    return { net, discovery, seedClients };
  };

  beforeEach(() => {
    now = 0;
    fallback.mockReset();
    fallback.mockResolvedValue([]);
  });

  async function settle<T>(promise: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(100);
    return promise;
  }

  it('returns the evonodes from the masternode list, with a shared client over them', async () => {
    const { discovery, net } = discover({ 'seed-1.test': { kind: 'list', hosts: ['10.0.0.1', '10.0.0.2'] } });

    expect(discovery.sharedClient).toBeUndefined();
    await expect(settle(discovery.getNodes())).resolves.toEqual([
      { protocol: 'https', host: '10.0.0.1', port: 1443 },
      { protocol: 'https', host: '10.0.0.2', port: 1443 },
    ]);
    expect(fallback).not.toHaveBeenCalled();
    expect(discovery.sharedClient.addresses.map((a: DapiAddress) => a.host)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(net.streams[0].cancel).toHaveBeenCalled();
  });

  it(`reuses the list for ${EVONODE_LIST_MAX_AGE_MS / 60000} minutes, then reads it again`, async () => {
    const behaviour: Record<string, Behaviour> = { 'seed-1.test': { kind: 'list', hosts: ['10.0.0.1'] } };
    const { discovery, seedClients } = discover(behaviour);

    await settle(discovery.getNodes());
    const firstShared = discovery.sharedClient;
    now = EVONODE_LIST_MAX_AGE_MS - 1;
    behaviour['seed-1.test'] = { kind: 'list', hosts: ['10.0.0.9'] };
    expect((await discovery.getNodes()).map((a) => a.host)).toEqual(['10.0.0.1']);
    expect(seedClients()).toHaveLength(1);

    now = EVONODE_LIST_MAX_AGE_MS;
    expect((await settle(discovery.getNodes())).map((a) => a.host)).toEqual(['10.0.0.9']);
    expect(seedClients()).toHaveLength(2);
    // The shared client follows the new list; the old one is closed.
    expect(discovery.sharedClient).not.toBe(firstShared);
    await vi.advanceTimersByTimeAsync(0);
    expect(firstShared.disconnect).toHaveBeenCalled();
  });

  it('shares one read between concurrent callers', async () => {
    const { discovery, seedClients } = discover({ 'seed-1.test': { kind: 'list', hosts: ['10.0.0.1'] } });

    const a = discovery.getNodes();
    const b = discovery.getNodes();
    const warm = discovery.warm();
    await vi.advanceTimersByTimeAsync(100);

    await expect(a).resolves.toHaveLength(1);
    await expect(b).resolves.toHaveLength(1);
    await expect(warm).resolves.toBeUndefined();
    expect(seedClients()).toHaveLength(1);
  });

  it('falls back to the quorum service when the masternode list fails, and tries the list again next time', async () => {
    const behaviour: Record<string, Behaviour> = { 'seed-1.test': { kind: 'error-end' } };
    const { discovery, seedClients } = discover(behaviour);
    fallback.mockResolvedValue(['https://10.0.0.9:1443']);

    expect((await settle(discovery.getNodes())).map((a) => a.host)).toEqual(['10.0.0.9']);
    expect(fallback).toHaveBeenCalledOnce();

    behaviour['seed-1.test'] = { kind: 'list', hosts: ['10.0.0.1'] };
    expect((await settle(discovery.getNodes())).map((a) => a.host)).toEqual(['10.0.0.1']);
    expect(seedClients()).toHaveLength(2);
  });

  it('rejects when neither source yields an evonode, so nothing is broadcast', async () => {
    const { discovery } = discover({ 'seed-1.test': { kind: 'reject' } });

    const assertion = expect(discovery.getNodes()).rejects.toThrow(/No testnet evonodes found/);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('rejects at once when the signal aborts', async () => {
    const { discovery } = discover({});
    const controller = new AbortController();

    const pending = discovery.getNodes(controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('disconnect() stops an in-flight read and closes the shared client', async () => {
    const behaviour: Record<string, Behaviour> = { 'seed-1.test': { kind: 'list', hosts: ['10.0.0.1'] } };
    const { discovery, net } = discover(behaviour);
    await settle(discovery.getNodes());
    const shared = discovery.sharedClient;

    now = EVONODE_LIST_MAX_AGE_MS;
    behaviour['seed-1.test'] = { kind: 'silent' };
    const warm = discovery.warm();
    await vi.advanceTimersByTimeAsync(10);
    await discovery.disconnect();
    await warm;

    expect(shared.disconnect).toHaveBeenCalled();
    expect(net.streams[1].cancel).toHaveBeenCalled();
    expect(discovery.sharedClient).toBeUndefined();
  });

  it('warm() settles without rejecting when the read fails', async () => {
    const { discovery } = discover({ 'seed-1.test': { kind: 'reject' } });

    await expect(settle(discovery.warm())).resolves.toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });
});
