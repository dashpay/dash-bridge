/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'node:events';
import cbor from 'cbor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A "masternode list" here is CBOR of { hosts: [...] }; the fake parser turns
// each host into a valid evonode on port 1443 ('bad' hosts make it throw).
// Networks the list parser was given, so tests can check mainnet lists are parsed as mainnet.
const parsedNetworks = vi.hoisted(() => [] as string[]);

vi.mock('@dashevo/dashcore-lib', () => {
  class SimplifiedMNListDiff {
    hosts: string[];
    constructor(obj: { hosts: string[] }, public network: string) {
      parsedNetworks.push(network);
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
  EVONODE_LIST_STALE_LIMIT_MS,
  EvonodeDiscovery,
  LIST_FETCH_TIMING,
  MASTERNODE_LIST_TIMEOUT_MS,
  MIN_HEALTHY_EVONODES,
  SEED_HEDGE_DELAY_MS,
  evonodeEndpointsFromSml,
  fetchEvonodesFromSeeds,
  parseDapiAddress,
  seedAddresses,
  type DapiAddress,
} from './evonode-discovery.js';

const listMessage = (...hosts: string[]) => ({ getMasternodeListDiff_asU8: () => new Uint8Array(cbor.encode({ hosts })) });
const endpoint = (host: string) => `https://${host}:1443`;

type Behaviour =
  | { kind: 'list'; hosts: string[] }
  | { kind: 'reject' }
  | { kind: 'error-end' }
  | { kind: 'end' }
  | { kind: 'silent' }
  | { kind: 'slow-open'; afterMs: number };

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
          if (b.kind === 'slow-open') await new Promise((r) => setTimeout(r, b.afterMs));
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
            if (b.kind === 'end') stream.emit('end');
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
    const entry = (platform: unknown) => ({ getPlatformHTTPSEndpoint: () => platform });
    const sml = {
      getValidMasternodesList: () => [
        entry({ host: '68.67.122.1', port: 1443 }),
        entry(null), // regular masternode
        entry({ host: '68.67.122.1', port: 1443 }),
        entry({ host: '2001:db8::1', port: 1443 }),
        entry({ host: 'evo.example.org', port: 2443 }),
      ],
    };

    expect(evonodeEndpointsFromSml(sml)).toEqual(['https://68.67.122.1:1443', 'https://evo.example.org:2443']);
  });
});

describe('fetchEvonodesFromSeeds', () => {
  it('reads the list from the first seed, closes its stream and client, and asks no other seed', async () => {
    const net = fakeNetwork({ 'seed-1.test': { kind: 'list', hosts: ['10.0.0.1', '10.0.0.2'] } });

    const result = fetchEvonodesFromSeeds(seeds, net.createClient, 'testnet');
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual([endpoint('10.0.0.1'), endpoint('10.0.0.2')]);
    expect(net.streams[0].cancel).toHaveBeenCalled();
    expect(net.clients[0].disconnect).toHaveBeenCalled();
    expect(net.clients[0].core.subscribeToMasternodeList).toHaveBeenCalledWith({ retries: 0 });
    // The hedge timer is cleared with the result.
    await vi.advanceTimersByTimeAsync(SEED_HEDGE_DELAY_MS * 2);
    expect(net.clients).toHaveLength(1);
  });

  it.each(['reject', 'error-end', 'end'] as const)('moves to the next seed at once when a seed fails (%s)', async (kind) => {
    const net = fakeNetwork({
      'seed-1.test': { kind },
      'seed-2.test': { kind: 'list', hosts: ['10.0.0.5'] },
    });

    const result = fetchEvonodesFromSeeds(seeds, net.createClient, 'testnet');
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual([endpoint('10.0.0.5')]);
    expect(net.clients.map((c) => c.addresses[0].host)).toEqual(['seed-1.test', 'seed-2.test']);
    expect(net.clients[0].disconnect).toHaveBeenCalled();
  });

  it('treats a list with no valid evonodes as a failed seed', async () => {
    const net = fakeNetwork({
      'seed-1.test': { kind: 'list', hosts: [] },
      'seed-2.test': { kind: 'list', hosts: ['10.0.0.5'] },
    });

    const result = fetchEvonodesFromSeeds(seeds, net.createClient, 'testnet');
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual([endpoint('10.0.0.5')]);
  });

  it('treats a list it cannot parse as a failed seed', async () => {
    const net = fakeNetwork({
      'seed-1.test': { kind: 'list', hosts: ['bad'] },
      'seed-2.test': { kind: 'list', hosts: ['10.0.0.5'] },
    });

    const result = fetchEvonodesFromSeeds(seeds, net.createClient, 'testnet');
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual([endpoint('10.0.0.5')]);
  });

  it(`asks the next seed too when one is silent for ${SEED_HEDGE_DELAY_MS} ms, and cancels the slow one`, async () => {
    const net = fakeNetwork({
      'seed-1.test': { kind: 'silent' },
      'seed-2.test': { kind: 'list', hosts: ['10.0.0.5'] },
    });

    const result = fetchEvonodesFromSeeds(seeds, net.createClient, 'testnet');
    await vi.advanceTimersByTimeAsync(SEED_HEDGE_DELAY_MS - 1);
    expect(net.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(101);

    await expect(result).resolves.toEqual([endpoint('10.0.0.5')]);
    expect(net.streams[0].cancel).toHaveBeenCalled();
    expect(net.clients[0].disconnect).toHaveBeenCalled();
  });

  it('cancels a stream that opens only after another seed delivered the list', async () => {
    const net = fakeNetwork({
      'seed-1.test': { kind: 'slow-open', afterMs: SEED_HEDGE_DELAY_MS + 1000 },
      'seed-2.test': { kind: 'list', hosts: ['10.0.0.5'] },
    });

    const result = fetchEvonodesFromSeeds(seeds, net.createClient, 'testnet');
    await vi.advanceTimersByTimeAsync(SEED_HEDGE_DELAY_MS + 100);
    await expect(result).resolves.toEqual([endpoint('10.0.0.5')]);
    expect(net.streams).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(net.streams).toHaveLength(2);
    expect(net.streams[1].cancel).toHaveBeenCalled();
  });

  it('rejects once every seed failed', async () => {
    const net = fakeNetwork({
      'seed-1.test': { kind: 'reject' },
      'seed-2.test': { kind: 'error-end' },
      'seed-3.test': { kind: 'reject' },
    });

    const result = fetchEvonodesFromSeeds(seeds, net.createClient, 'testnet');
    const assertion = expect(result).rejects.toThrow(/3 seeds tried/);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(net.clients).toHaveLength(3);
  });

  it(`rejects after ${MASTERNODE_LIST_TIMEOUT_MS} ms and closes every stream`, async () => {
    const net = fakeNetwork({});

    const result = fetchEvonodesFromSeeds(seeds, net.createClient, 'testnet');
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

    const result = fetchEvonodesFromSeeds(seeds, net.createClient, 'testnet', controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();

    await expect(result).rejects.toThrow(/aborted/);
    expect(net.streams[0].cancel).toHaveBeenCalled();
  });

  it('parses a mainnet list as mainnet', async () => {
    parsedNetworks.length = 0;
    const net = fakeNetwork({ 'seed-1.mainnet.test': { kind: 'list', hosts: ['10.0.0.1'] } });

    const result = fetchEvonodesFromSeeds(seedAddresses(['seed-1.mainnet.test']), net.createClient, 'mainnet');
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual([endpoint('10.0.0.1')]);
    expect(parsedNetworks).toEqual(['mainnet']);
  });

  it('gives the bigger mainnet list longer: hedge at 8 s, give up at 25 s', async () => {
    const net = fakeNetwork({});
    const mainnetSeeds = seedAddresses(['seed-1.mainnet.test', 'seed-2.mainnet.test', 'seed-3.mainnet.test', 'seed-4.mainnet.test']);

    const result = fetchEvonodesFromSeeds(mainnetSeeds, net.createClient, 'mainnet');
    const assertion = expect(result).rejects.toThrow(`timed out after ${LIST_FETCH_TIMING.mainnet.timeoutMs}ms`);
    await vi.advanceTimersByTimeAsync(SEED_HEDGE_DELAY_MS);
    expect(net.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LIST_FETCH_TIMING.mainnet.hedgeDelayMs - SEED_HEDGE_DELAY_MS);
    expect(net.clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(MASTERNODE_LIST_TIMEOUT_MS);
    expect(mainnetSeeds[0].port).toBe(443);
    await vi.advanceTimersByTimeAsync(LIST_FETCH_TIMING.mainnet.timeoutMs);
    await assertion;
  });

  it('rejects without contacting a seed when the signal is already aborted or there are no seeds', async () => {
    const net = fakeNetwork({});
    const controller = new AbortController();
    controller.abort();

    await expect(fetchEvonodesFromSeeds(seeds, net.createClient, 'testnet', controller.signal)).rejects.toThrow(/aborted/);
    await expect(fetchEvonodesFromSeeds([], net.createClient, 'testnet')).rejects.toThrow(/No masternode list seeds/);
    expect(net.clients).toHaveLength(0);
  });
});

describe('EvonodeDiscovery', () => {
  const healthy = vi.fn<[], Promise<string[]>>();
  let now = 0;
  const discover = (behaviour: Record<string, Behaviour>) => {
    const net = fakeNetwork(behaviour);
    const discovery = new EvonodeDiscovery({
      network: 'testnet',
      seeds: seeds.slice(0, 1),
      createClient: net.createClient,
      fetchHealthy: healthy,
      now: () => now,
    });
    const seedClients = () => net.clients.filter((c) => c.addresses[0].host.startsWith('seed-'));
    return { net, discovery, seedClients };
  };
  const hostsOf = (nodes: DapiAddress[]) => nodes.map((a) => a.host);

  beforeEach(() => {
    now = 0;
    healthy.mockReset();
    healthy.mockResolvedValue([]);
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
    expect(healthy).toHaveBeenCalledOnce();
    expect(hostsOf(discovery.sharedClient.addresses)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(net.streams[0].cancel).toHaveBeenCalled();
  });

  it(`narrows to the nodes the quorum service also vouches for when at least ${MIN_HEALTHY_EVONODES} are`, async () => {
    const { discovery } = discover({ 'seed-1.test': { kind: 'list', hosts: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5'] } });
    // 10.0.0.9 is not in the masternode list, so it is never used.
    healthy.mockResolvedValue(['10.0.0.2', '10.0.0.3', '10.0.0.5', '10.0.0.9'].map(endpoint));

    expect(hostsOf(await settle(discovery.getNodes()))).toEqual(['10.0.0.2', '10.0.0.3', '10.0.0.5']);
  });

  it(`keeps the whole list when fewer than ${MIN_HEALTHY_EVONODES} nodes are vouched for`, async () => {
    const { discovery } = discover({ 'seed-1.test': { kind: 'list', hosts: ['10.0.0.1', '10.0.0.2', '10.0.0.3'] } });
    healthy.mockResolvedValue(['10.0.0.2', '10.0.0.3'].map(endpoint));

    expect(hostsOf(await settle(discovery.getNodes()))).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  });

  it(`reuses the list for ${EVONODE_LIST_MAX_AGE_MS / 60000} minutes, then reads it again`, async () => {
    const behaviour: Record<string, Behaviour> = { 'seed-1.test': { kind: 'list', hosts: ['10.0.0.1'] } };
    const { discovery, seedClients } = discover(behaviour);

    await settle(discovery.getNodes());
    const firstShared = discovery.sharedClient;
    now = EVONODE_LIST_MAX_AGE_MS - 1;
    behaviour['seed-1.test'] = { kind: 'list', hosts: ['10.0.0.9'] };
    expect(hostsOf(await discovery.getNodes())).toEqual(['10.0.0.1']);
    expect(seedClients()).toHaveLength(1);

    // Past the max age the old list is served at once while a new one is read.
    now = EVONODE_LIST_MAX_AGE_MS;
    expect(hostsOf(await discovery.getNodes())).toEqual(['10.0.0.1']);
    expect(seedClients()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(hostsOf(await discovery.getNodes())).toEqual(['10.0.0.9']);
    // The shared client follows the new list; the old one is closed.
    expect(discovery.sharedClient).not.toBe(firstShared);
    await vi.advanceTimersByTimeAsync(0);
    expect(firstShared.disconnect).toHaveBeenCalled();
  });

  it('keeps the previous list when a later read finds nothing', async () => {
    const behaviour: Record<string, Behaviour> = { 'seed-1.test': { kind: 'list', hosts: ['10.0.0.1'] } };
    const { discovery } = discover(behaviour);
    await settle(discovery.getNodes());

    // Even past the stale limit, where the read is awaited.
    now = EVONODE_LIST_STALE_LIMIT_MS;
    behaviour['seed-1.test'] = { kind: 'reject' };
    expect(hostsOf(await settle(discovery.getNodes()))).toEqual(['10.0.0.1']);
  });

  it(`awaits a new read once the list is older than ${EVONODE_LIST_STALE_LIMIT_MS / 60000} minutes`, async () => {
    const behaviour: Record<string, Behaviour> = { 'seed-1.test': { kind: 'list', hosts: ['10.0.0.1'] } };
    const { discovery } = discover(behaviour);
    await settle(discovery.getNodes());

    now = EVONODE_LIST_STALE_LIMIT_MS;
    behaviour['seed-1.test'] = { kind: 'list', hosts: ['10.0.0.9'] };
    expect(hostsOf(await settle(discovery.getNodes()))).toEqual(['10.0.0.9']);
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
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('uses the quorum service list when the masternode list fails, and keeps it for the max age', async () => {
    const behaviour: Record<string, Behaviour> = { 'seed-1.test': { kind: 'error-end' } };
    const { discovery, seedClients } = discover(behaviour);
    healthy.mockResolvedValue([endpoint('10.0.0.9')]);

    expect(hostsOf(await settle(discovery.getNodes()))).toEqual(['10.0.0.9']);
    // Kept: a dead seed set doesn't cost every subscription the full deadline.
    expect(hostsOf(await discovery.getNodes())).toEqual(['10.0.0.9']);
    expect(seedClients()).toHaveLength(1);

    now = EVONODE_LIST_STALE_LIMIT_MS;
    behaviour['seed-1.test'] = { kind: 'list', hosts: ['10.0.0.1'] };
    expect(hostsOf(await settle(discovery.getNodes()))).toEqual(['10.0.0.1']);
  });

  it('rejects when neither source ever yields an evonode, so nothing is broadcast', async () => {
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
    await vi.advanceTimersByTimeAsync(0);

    expect(shared.disconnect).toHaveBeenCalled();
    expect(net.streams[1].cancel).toHaveBeenCalled();
    expect(discovery.sharedClient).toBeUndefined();
  });

  it('warm() settles without rejecting when the read fails', async () => {
    const { discovery } = discover({ 'seed-1.test': { kind: 'reject' } });

    await expect(settle(discovery.warm())).resolves.toBeUndefined();
  });
});
