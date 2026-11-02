/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DISCOVERY_TIMEOUT_MS,
  EvonodeDiscovery,
  evonodeEndpointsFromSml,
  parseDapiAddress,
} from './evonode-discovery.js';

const entry = (ip: string, overrides: Record<string, unknown> = {}) => ({
  nType: 1,
  platformHTTPPort: 1443,
  getIp: () => ip,
  ...overrides,
});
const sml = (...entries: unknown[]) => ({ getValidMasternodesList: () => entries });

/** A stand-in for a dapi-client instance: just its masternode list provider and disconnect(). */
function fakeClient(getList: () => Promise<unknown>) {
  const smlProvider: any = {
    stream: undefined,
    getSimplifiedMNList: vi.fn(async () => {
      const list = await getList();
      smlProvider.stream = {};
      return list;
    }),
  };
  return { dapiAddressProvider: { smlProvider }, disconnect: vi.fn(async () => {}) };
}

describe('evonodeEndpointsFromSml', () => {
  it('keeps valid evonodes, using their Platform HTTP port, without duplicates', () => {
    const result = evonodeEndpointsFromSml(
      sml(
        entry('68.67.122.1'),
        entry('68.67.122.2', { nType: 0 }), // regular masternode: no DAPI
        entry('68.67.122.3', { platformHTTPPort: '2443' }),
        entry('68.67.122.1'),
        entry('0.0.0.0.0'),
        entry('68.67.122.4', { platformHTTPPort: undefined }),
        entry('68.67.122.5', { getIp: undefined }),
        null
      )
    );

    expect(result).toEqual(['https://68.67.122.1:1443', 'https://68.67.122.3:2443']);
  });

  it.each([undefined, null, {}, { getValidMasternodesList: () => undefined }])(
    'returns nothing for list %j',
    (bad) => {
      expect(evonodeEndpointsFromSml(bad)).toEqual([]);
    }
  );
});

describe('parseDapiAddress', () => {
  it('splits a URL into the address object dapi-client takes', () => {
    expect(parseDapiAddress('https://68.67.122.1:1443')).toEqual({ protocol: 'https', host: '68.67.122.1', port: 1443 });
    expect(parseDapiAddress('https://evo.example.org')).toEqual({ protocol: 'https', host: 'evo.example.org', port: 443 });
  });
});

describe('EvonodeDiscovery', () => {
  const fallback = vi.fn<[], Promise<string[]>>();
  let clients: ReturnType<typeof fakeClient>[];
  let lists: Array<() => Promise<unknown>>;

  const createClient = () => {
    const client = fakeClient(lists[Math.min(clients.length, lists.length - 1)]);
    clients.push(client);
    return client;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fallback.mockReset();
    fallback.mockResolvedValue([]);
    clients = [];
    lists = [async () => sml(entry('10.0.0.1'), entry('10.0.0.2'))];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the evonodes from the masternode list and does not ask the quorum service', async () => {
    const discovery = new EvonodeDiscovery(createClient, fallback);

    await expect(discovery.getNodes()).resolves.toEqual([
      { protocol: 'https', host: '10.0.0.1', port: 1443 },
      { protocol: 'https', host: '10.0.0.2', port: 1443 },
    ]);
    expect(fallback).not.toHaveBeenCalled();
    expect(discovery.sharedClient).toBe(clients[0]);
  });

  it('reads the current list on every call, so updates from the list stream are seen', async () => {
    let current = sml(entry('10.0.0.1'));
    lists = [async () => current];
    const discovery = new EvonodeDiscovery(createClient, fallback);

    expect((await discovery.getNodes()).map((a) => a.host)).toEqual(['10.0.0.1']);
    current = sml(entry('10.0.0.7'), entry('10.0.0.8'));
    expect((await discovery.getNodes()).map((a) => a.host)).toEqual(['10.0.0.7', '10.0.0.8']);
    expect(clients).toHaveLength(1);
  });

  it('shares one in-flight sync between concurrent callers', async () => {
    let release!: () => void;
    lists = [() => new Promise((resolve) => { release = () => resolve(sml(entry('10.0.0.1'))); })];
    const discovery = new EvonodeDiscovery(createClient, fallback);

    const a = discovery.getNodes();
    const b = discovery.getNodes();
    const warm = discovery.warm();
    release();

    await expect(a).resolves.toHaveLength(1);
    await expect(b).resolves.toHaveLength(1);
    await expect(warm).resolves.toBeUndefined();
    expect(clients[0].dapiAddressProvider.smlProvider.getSimplifiedMNList).toHaveBeenCalledTimes(1);
  });

  it('falls back to the quorum service when the masternode list sync fails', async () => {
    lists = [async () => { throw new Error('Failed to parse payload'); }];
    fallback.mockResolvedValue(['https://10.0.0.9:1443']);
    const discovery = new EvonodeDiscovery(createClient, fallback);

    await expect(discovery.getNodes()).resolves.toEqual([{ protocol: 'https', host: '10.0.0.9', port: 1443 }]);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('falls back to the quorum service when the list has no valid evonodes', async () => {
    lists = [async () => sml(entry('10.0.0.1', { nType: 0 }))];
    fallback.mockResolvedValue(['https://10.0.0.9:1443']);
    const discovery = new EvonodeDiscovery(createClient, fallback);

    await expect(discovery.getNodes()).resolves.toHaveLength(1);
  });

  it(`falls back after ${DISCOVERY_TIMEOUT_MS} ms and starts over on a new client next time`, async () => {
    lists = [() => new Promise(() => {}), async () => sml(entry('10.0.0.5'))];
    fallback.mockResolvedValue(['https://10.0.0.9:1443']);
    const discovery = new EvonodeDiscovery(createClient, fallback);

    const first = discovery.getNodes();
    await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS);
    expect((await first).map((a) => a.host)).toEqual(['10.0.0.9']);

    expect((await discovery.getNodes()).map((a) => a.host)).toEqual(['10.0.0.5']);
    expect(clients).toHaveLength(2);
    expect(clients[0].disconnect).toHaveBeenCalled();
    expect(discovery.sharedClient).toBe(clients[1]);
  });

  it('replaces the client once dapi-client dropped its list stream, instead of serving the stale list', async () => {
    lists = [async () => sml(entry('10.0.0.1')), async () => sml(entry('10.0.0.2'))];
    const discovery = new EvonodeDiscovery(createClient, fallback);
    await discovery.getNodes();

    // What dapi-client does when the masternode list stream errors or ends.
    clients[0].dapiAddressProvider.smlProvider.stream = null;

    expect((await discovery.getNodes()).map((a) => a.host)).toEqual(['10.0.0.2']);
    expect(clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(clients[0].disconnect).toHaveBeenCalled();
  });

  it('rejects when neither source yields an evonode, so nothing is broadcast', async () => {
    lists = [async () => { throw new Error('No available addresses'); }];
    const discovery = new EvonodeDiscovery(createClient, fallback);

    await expect(discovery.getNodes()).rejects.toThrow(/No testnet evonodes found/);
  });

  it('rejects at once when the signal aborts during the sync', async () => {
    lists = [() => new Promise(() => {})];
    const discovery = new EvonodeDiscovery(createClient, fallback);
    const controller = new AbortController();

    const pending = discovery.getNodes(controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('warm() settles without rejecting when the sync fails', async () => {
    lists = [async () => { throw new Error('boom'); }];
    const discovery = new EvonodeDiscovery(createClient, fallback);

    await expect(discovery.warm()).resolves.toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('disconnect() closes the client', async () => {
    const discovery = new EvonodeDiscovery(createClient, fallback);
    await discovery.disconnect();
    expect(clients[0].disconnect).toHaveBeenCalledOnce();
  });
});
