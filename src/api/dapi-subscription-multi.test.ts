/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  clients: [] as any[],
  deadHosts: new Set<string>(),
  // Hosts whose best-block-height call hangs forever / rejects.
  hungHeightHosts: new Set<string>(),
  failedHeightHosts: new Set<string>(),
  // Hosts whose subscribe call stays pending until releaseSlow() is called.
  slowHosts: new Set<string>(),
  slowWaiters: [] as Array<() => void>,
  releaseSlow(): void {
    state.slowWaiters.splice(0).forEach((release) => release());
  },
  height: 100,
}));

vi.mock('@dashevo/dapi-client', () => {
  class FakeClient {
    options: any;
    streams: any[] = [];
    disconnect = vi.fn(async () => {});
    core: any;
    platform = {};

    constructor(options: any) {
      this.options = options;
      state.clients.push(this);
      this.core = {
        getBestBlockHeight: vi.fn(async () => {
          const only = options.dapiAddresses?.length === 1 ? options.dapiAddresses[0].host : undefined;
          // A blackholed node never answers (the real transport gives up after ~75 s).
          if (only && state.hungHeightHosts.has(only)) return new Promise<number>(() => {});
          if (only && state.failedHeightHosts.has(only)) throw new Error('GrpcError: height refused');
          return state.height;
        }),
        subscribeToTransactionsWithProofs: vi.fn(async (_filter: unknown, _opts: unknown) => {
          if (options.dapiAddresses?.length === 1 && state.deadHosts.has(options.dapiAddresses[0].host)) {
            throw new Error('GrpcError: Response closed without headers');
          }
          if (options.dapiAddresses?.length === 1 && state.slowHosts.has(options.dapiAddresses[0].host)) {
            await new Promise<void>((resolve) => state.slowWaiters.push(resolve));
          }
          const stream: any = new EventEmitter();
          stream.cancel = vi.fn();
          this.streams.push(stream);
          return stream;
        }),
      };
    }
  }
  return { default: FakeClient };
});

vi.mock('@dashevo/dashcore-lib', () => ({
  default: {
    BloomFilter: Object.assign(
      {
        create: () => ({
          vData: [1, 2, 3],
          nHashFuncs: 2,
          nTweak: 7,
          nFlags: 1,
          insert: () => {},
        }),
      },
      { BLOOM_UPDATE_ALL: 1 }
    ),
    // Test "IS locks" are just the txid as UTF-8 bytes.
    InstantLock: {
      fromBuffer: (buf: Buffer) => ({ txid: buf.toString('utf8') }),
    },
  },
}));

vi.mock('../utils/islock-debug.js', () => ({ describeIslock: () => ({}) }));

import {
  DAPISubscriptionClient,
  ISLOCK_CONCURRENT_NODES,
  ISLOCK_MAX_NODE_ATTEMPTS,
  ISLOCK_HEIGHT_TIMEOUT_MS,
  ISLOCK_READINESS_CAP_MS,
} from './dapi-subscription.js';

const TXID = 'aa'.repeat(32);
const OTHER_TXID = 'bb'.repeat(32);
const PUBKEY = new Uint8Array(33).fill(2);
const UTXO = { txid: 'cc'.repeat(32), vout: 0 };
const TIMEOUT = 60000;

const addresses = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `https://node${i}.test:1443`);

const lockMessage = (txid: string) => ({
  getInstantSendLockMessages: () => ({ getMessagesList_asU8: () => [new TextEncoder().encode(txid)] }),
});
const blockMessage = { getRawMerkleBlock: () => new Uint8Array([1]) };

/** The one-address clients, in creation order. */
const nodeClients = (): any[] => state.clients.filter((c) => c.options.dapiAddresses?.length === 1);
const liveStreams = (): any[] => nodeClients().flatMap((c) => c.streams);
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

/** Start a subscription and let the first stream deliver a message so it returns. */
async function startReady(
  client: DAPISubscriptionClient,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
) {
  const pending = client.subscribeForInstantSendLock(
    TXID, PUBKEY, UTXO, opts.timeoutMs ?? TIMEOUT, undefined, opts.signal
  );
  await flush();
  liveStreams()[0]?.emit('data', blockMessage);
  return pending;
}

describe('DAPISubscriptionClient multi-node IS lock subscription', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.clients.length = 0;
    state.deadHosts.clear();
    state.hungHeightHosts.clear();
    state.failedHeightHosts.clear();
    state.slowHosts.clear();
    state.slowWaiters.length = 0;
    state.height = 100;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens one stream per distinct node, each on a client with exactly one address', async () => {
    const all = addresses(5);
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: all });
    const sub = await startReady(client);

    const nodes = nodeClients();
    expect(nodes).toHaveLength(ISLOCK_CONCURRENT_NODES);
    const hosts = nodes.map((c) => c.options.dapiAddresses[0].host);
    expect(new Set(hosts).size).toBe(ISLOCK_CONCURRENT_NODES);
    for (const host of hosts) expect(all.map((a) => new URL(a).hostname)).toContain(host);
    expect(nodes[0].options.dapiAddresses[0]).toMatchObject({ protocol: 'https', port: 1443 });

    // Height is asked of the same per-node clients (not the shared random-pick
    // client), once each, and every stream starts from height - 10.
    const shared = state.clients.find((c) => c.options.dapiAddresses?.length === 5);
    expect(shared.core.getBestBlockHeight).not.toHaveBeenCalled();
    for (const node of nodes) {
      expect(node.core.getBestBlockHeight).toHaveBeenCalledTimes(1);
      expect(node.core.getBestBlockHeight).toHaveBeenCalledWith({
        retries: 0,
        timeout: ISLOCK_HEIGHT_TIMEOUT_MS,
      });
      expect(node.core.subscribeToTransactionsWithProofs).toHaveBeenCalledTimes(1);
      expect(node.core.subscribeToTransactionsWithProofs.mock.calls[0][1]).toEqual({
        fromBlockHeight: 90,
        count: 0,
      });
    }
    const filters = nodes.map((c) => c.core.subscribeToTransactionsWithProofs.mock.calls[0][0]);
    expect(filters[1]).toBe(filters[0]);
    expect(filters[2]).toBe(filters[0]);

    liveStreams()[0].emit('data', lockMessage(TXID));
    await sub.wait();
  });

  it('uses fewer streams when fewer than three nodes are configured', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(2) });
    const sub = await startReady(client);
    expect(nodeClients()).toHaveLength(2);
    liveStreams()[0].emit('data', lockMessage(TXID));
    await sub.wait();
  });

  it('resolves with the first matching lock and tears down every other stream and client', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(4) });
    const sub = await startReady(client);
    const streams = liveStreams();
    expect(streams).toHaveLength(3);

    streams[1].emit('data', lockMessage(OTHER_TXID)); // not ours
    streams[1].emit('data', lockMessage(TXID));

    const bytes = await sub.wait();
    expect(new TextDecoder().decode(bytes)).toBe(TXID);
    for (const stream of streams) expect(stream.cancel).toHaveBeenCalled();
    for (const node of nodeClients()) expect(node.disconnect).toHaveBeenCalledTimes(1);
  });

  it('replaces a failed stream with an untried node and still gets the lock', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(5) });
    const sub = await startReady(client);
    const firstHosts = nodeClients().map((c) => c.options.dapiAddresses[0].host);

    const failing = liveStreams()[0];
    failing.emit('error', new Error('GrpcError: Response closed without headers'));
    await flush();

    const nodes = nodeClients();
    expect(nodes).toHaveLength(4);
    const replacementHost = nodes[3].options.dapiAddresses[0].host;
    expect(firstHosts).not.toContain(replacementHost);
    expect(nodes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(failing.cancel).toHaveBeenCalled();

    nodes[3].streams[0].emit('data', lockMessage(TXID));
    const bytes = await sub.wait();
    expect(new TextDecoder().decode(bytes)).toBe(TXID);
    for (const node of nodes) expect(node.disconnect).toHaveBeenCalled();
  });

  it('logs which node delivered the lock and how long it took', async () => {
    const log = vi.spyOn(console, 'log');
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    const sub = await startReady(client);
    await vi.advanceTimersByTimeAsync(250);

    const winner = nodeClients()[1];
    winner.streams[0].emit('data', lockMessage(TXID));
    await sub.wait();

    const host = winner.options.dapiAddresses[0].host;
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.startsWith('[islock-sub] IS lock for'))).toEqual([
      `[islock-sub] IS lock for ${TXID} from ${host}:1443 after 250 ms since subscribe`,
    ]);
  });

  it('treats a stream ending before a lock as a failure and replaces it', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(4) });
    const sub = await startReady(client);

    liveStreams()[2].emit('end');
    await flush();
    expect(nodeClients()).toHaveLength(4);

    nodeClients()[3].streams[0].emit('data', lockMessage(TXID));
    await sub.wait();
  });

  it('still resolves when one node is dead from the start', async () => {
    const all = addresses(3);
    state.deadHosts.add('node0.test');
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: all });
    const sub = await startReady(client);

    // The dead node rejects its subscribe call, so only two streams exist.
    expect(liveStreams()).toHaveLength(2);
    liveStreams()[1].emit('data', lockMessage(TXID));
    const bytes = await sub.wait();
    expect(new TextDecoder().decode(bytes)).toBe(TXID);
  });

  describe('block height race', () => {
    it('is not delayed by a node whose height request hangs', async () => {
      state.hungHeightHosts.add('node0.test');
      const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
      const sub = await startReady(client); // no timers advanced: far below the 8 s deadline

      expect(liveStreams()).toHaveLength(3);
      for (const node of nodeClients()) {
        expect(node.core.subscribeToTransactionsWithProofs.mock.calls[0][1]).toEqual({
          fromBlockHeight: 90,
          count: 0,
        });
      }
      liveStreams()[1].emit('data', lockMessage(TXID));
      await sub.wait();
    });

    it('survives nodes whose height request fails as long as one answers', async () => {
      state.failedHeightHosts.add('node0.test');
      state.hungHeightHosts.add('node1.test');
      state.height = 500; // only node2 answers
      const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
      const sub = await startReady(client);

      for (const node of nodeClients()) {
        expect(node.core.subscribeToTransactionsWithProofs.mock.calls[0][1].fromBlockHeight).toBe(490);
      }
      liveStreams()[0].emit('data', lockMessage(TXID));
      await sub.wait();
    });

    it('rejects within the per-request deadline, naming the nodes tried, when every node hangs', async () => {
      for (const host of ['node0.test', 'node1.test', 'node2.test']) state.hungHeightHosts.add(host);
      const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
      const pending = client.subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT);
      const outcome = expect(pending).rejects.toThrow(
        new RegExp(`failed for ${TXID}: 3 nodes tried, last error: getBestBlockHeight timed out after ${ISLOCK_HEIGHT_TIMEOUT_MS}ms`)
      );

      await vi.advanceTimersByTimeAsync(ISLOCK_HEIGHT_TIMEOUT_MS - 1);
      expect(nodeClients().flatMap((c) => c.streams)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;

      // Nothing was opened and every probe client was cleaned up.
      expect(liveStreams()).toHaveLength(0);
      for (const node of nodeClients()) {
        expect(node.core.subscribeToTransactionsWithProofs).not.toHaveBeenCalled();
        expect(node.disconnect).toHaveBeenCalled();
      }
    });

    it('rejects at once when every node fails its height request', async () => {
      for (const host of ['node0.test', 'node1.test', 'node2.test']) state.failedHeightHosts.add(host);
      const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
      const pending = client.subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT);
      const outcome = expect(pending).rejects.toThrow(/3 nodes tried.*height refused/);
      await flush();
      await outcome;
    });

    it('stops waiting for heights when the client is disconnected', async () => {
      for (const host of ['node0.test', 'node1.test', 'node2.test']) state.hungHeightHosts.add(host);
      const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
      const pending = client.subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT);
      const outcome = expect(pending).rejects.toThrow(`InstantSend lock subscription aborted for ${TXID}`);
      await flush();

      await client.disconnect(); // e.g. switchNetwork while the height is still pending
      await outcome;
      expect(liveStreams()).toHaveLength(0); // no stream opened on the network being left
      for (const node of nodeClients()) expect(node.disconnect).toHaveBeenCalled();
    });

    it('stops waiting for heights when the caller aborts', async () => {
      for (const host of ['node0.test', 'node1.test', 'node2.test']) state.hungHeightHosts.add(host);
      const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
      const controller = new AbortController();
      const pending = client.subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT, undefined, controller.signal);
      const outcome = expect(pending).rejects.toThrow(`InstantSend lock subscription aborted for ${TXID}`);
      await flush();
      controller.abort();
      await outcome;
      for (const node of nodeClients()) expect(node.disconnect).toHaveBeenCalled();
    });
  });

  it('rejects wait() naming the nodes tried and the last error when every node fails after readiness', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    const sub = await startReady(client);
    const outcome = expect(sub.wait()).rejects.toThrow(/3 nodes tried.*last error: boom 2/);

    liveStreams().forEach((stream, i) => stream.emit('error', new Error(`boom ${i}`)));
    await outcome;
    for (const node of nodeClients()) expect(node.disconnect).toHaveBeenCalled();
  });

  it('still returns a handle when readiness comes from the cap, and a later total failure surfaces via wait()', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    const pending = client.subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT);
    await vi.advanceTimersByTimeAsync(ISLOCK_READINESS_CAP_MS);
    const sub = await pending; // streams are open but silent: returns at the cap

    const outcome = expect(sub.wait()).rejects.toThrow(/3 nodes tried.*last error: late boom 2/);
    liveStreams().forEach((stream, i) => stream.emit('error', new Error(`late boom ${i}`)));
    await outcome;
  });

  it('rejects subscribe itself, before returning, when every stream fails inside the readiness window', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    const pending = client.subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT);
    const outcome = expect(pending).rejects.toThrow(
      new RegExp(`InstantSend lock subscription failed for ${TXID}: 3 nodes tried, last error: boom 2`)
    );
    await flush(); // streams opened, nothing delivered yet

    liveStreams().forEach((stream, i) => stream.emit('error', new Error(`boom ${i}`)));
    await outcome;
    for (const node of nodeClients()) expect(node.disconnect).toHaveBeenCalled();
  });

  it('rejects subscribe immediately, without the readiness cap, when all nodes fail on connect', async () => {
    for (const host of addresses(3).map((a) => new URL(a).hostname)) state.deadHosts.add(host);
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    const pending = client.subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT);
    const outcome = expect(pending).rejects.toThrow(/3 nodes tried.*Response closed without headers/);
    await flush(); // far less than ISLOCK_READINESS_CAP_MS
    await outcome;
  });

  it('rejects subscribe after the attempt cap when replacements keep failing', async () => {
    const many = addresses(20);
    for (const a of many) state.deadHosts.add(new URL(a).hostname);
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: many });
    const pending = client.subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT);
    const outcome = expect(pending).rejects.toThrow(new RegExp(`${ISLOCK_MAX_NODE_ATTEMPTS} nodes tried`));
    await flush();
    await outcome;
    expect(nodeClients()).toHaveLength(ISLOCK_MAX_NODE_ATTEMPTS);
  });

  it('keeps the timeout message and cleans up when no lock arrives', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    const sub = await startReady(client, { timeoutMs: 10000 });
    const outcome = expect(sub.wait()).rejects.toThrow(
      `Timeout waiting for InstantSend lock for ${TXID} after 10000ms`
    );
    await vi.advanceTimersByTimeAsync(10000);
    await outcome;
    for (const stream of liveStreams()) expect(stream.cancel).toHaveBeenCalled();
    for (const node of nodeClients()) expect(node.disconnect).toHaveBeenCalled();
  });

  it('keeps the abort message, both before and during the subscription', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      client.subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT, undefined, preAborted.signal)
    ).rejects.toThrow(`InstantSend lock subscription aborted for ${TXID}`);
    expect(state.clients).toHaveLength(1); // only the shared client from the constructor

    const controller = new AbortController();
    const sub = await startReady(client, { signal: controller.signal });
    const outcome = expect(sub.wait()).rejects.toThrow(`InstantSend lock subscription aborted for ${TXID}`);
    controller.abort();
    await outcome;
    for (const stream of liveStreams()) expect(stream.cancel).toHaveBeenCalled();
  });

  it('ignores late locks and errors after the winner', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(5) });
    const sub = await startReady(client);
    const streams = liveStreams();
    streams[0].emit('data', lockMessage(TXID));
    const bytes = await sub.wait();

    const clientCount = state.clients.length;
    expect(() => {
      streams[1].emit('data', lockMessage(TXID));
      streams[0].emit('data', lockMessage(TXID));
      streams[1].emit('error', new Error('Cancelled on client'));
      streams[2].emit('error', new Error('late'));
      streams[2].emit('end');
    }).not.toThrow();
    await flush();

    expect(state.clients).toHaveLength(clientCount); // no replacements after the win
    for (const node of nodeClients()) expect(node.disconnect).toHaveBeenCalledTimes(1);
    await expect(sub.wait()).resolves.toBe(bytes);
  });

  it('aborting during the readiness window rejects wait() and closes every stream', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    const controller = new AbortController();
    const pending = client.subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT, undefined, controller.signal);
    const outcome = pending.then((sub) => expect(sub.wait()).rejects.toThrow(/aborted/));
    await flush();
    controller.abort();
    await flush();
    await outcome;
    for (const stream of liveStreams()) expect(stream.cancel).toHaveBeenCalled();
  });

  it('cancels a stream whose subscribe call resolves only after the winner is decided', async () => {
    state.slowHosts.add('node2.test');
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    const sub = await startReady(client);
    expect(liveStreams()).toHaveLength(2);
    liveStreams()[0].emit('data', lockMessage(TXID));
    await sub.wait();

    state.releaseSlow();
    await flush();
    const late = nodeClients().find((c) => c.options.dapiAddresses[0].host === 'node2.test').streams[0];
    expect(late.cancel).toHaveBeenCalled();
    expect(late.listenerCount('data')).toBe(0);
  });

  it('returns after the readiness cap when no stream emits data', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    let returned = false;
    const pending = client
      .subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT)
      .then((sub) => { returned = true; return sub; });

    await vi.advanceTimersByTimeAsync(ISLOCK_READINESS_CAP_MS - 1);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const sub = await pending;
    expect(returned).toBe(true);

    // Streams are still connecting in the background and can still win.
    liveStreams()[2].emit('data', lockMessage(TXID));
    await sub.wait();
  });

  it('returns as soon as the first stream emits data, not after all of them', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    let returned = false;
    const pending = client
      .subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT)
      .then((sub) => { returned = true; return sub; });
    await flush();
    expect(returned).toBe(false);

    liveStreams()[1].emit('data', blockMessage);
    const sub = await pending;
    expect(returned).toBe(true);
    liveStreams()[0].emit('data', lockMessage(TXID));
    await sub.wait();
  });

  it('uses the single shared client with fewer than two addresses', async () => {
    for (const dapiAddresses of [undefined, [] as string[], addresses(1)]) {
      state.clients.length = 0;
      const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses });
      expect(state.clients).toHaveLength(1);

      const pending = client.subscribeForInstantSendLock(TXID, PUBKEY, UTXO, TIMEOUT);
      await flush();
      const sub = await pending; // returns without waiting for data, as before

      expect(state.clients).toHaveLength(1);
      const shared = state.clients[0];
      expect(shared.core.subscribeToTransactionsWithProofs).toHaveBeenCalledTimes(1);
      expect(shared.streams).toHaveLength(1);
      shared.streams[0].emit('data', lockMessage(TXID));
      await sub.wait();
      expect(shared.streams[0].cancel).toHaveBeenCalled();
    }
  });

  it('disconnect() stops in-flight subscriptions and closes their per-node clients', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    const sub = await startReady(client);
    const outcome = expect(sub.wait()).rejects.toThrow(`InstantSend lock subscription aborted for ${TXID}`);

    await client.disconnect();
    await outcome;
    const shared = state.clients.find((c) => c.options.dapiAddresses?.length === 3);
    expect(shared.disconnect).toHaveBeenCalledTimes(1);
    for (const stream of liveStreams()) expect(stream.cancel).toHaveBeenCalled();
    for (const node of nodeClients()) expect(node.disconnect).toHaveBeenCalledTimes(1);
    expect(nodeClients()).toHaveLength(3); // no replacements opened after disconnect
  });

  it('disconnect() after a finished subscription does not touch per-node clients again', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(3) });
    const sub = await startReady(client);
    liveStreams()[0].emit('data', lockMessage(TXID));
    await sub.wait();

    await client.disconnect();
    for (const node of nodeClients()) expect(node.disconnect).toHaveBeenCalledTimes(1);
  });

  it('counts one failure once when a stream reports both error and end', async () => {
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: addresses(5) });
    const sub = await startReady(client);

    const failing = liveStreams()[0];
    failing.emit('error', new Error('boom'));
    failing.emit('end');
    await flush();

    expect(nodeClients()).toHaveLength(4); // one replacement, not two
    nodeClients()[3].streams[0].emit('data', lockMessage(TXID));
    await sub.wait();
  });

  it('never puts two streams on a repeated address', async () => {
    const dup = ['https://a.test:1443', 'https://a.test:1443', 'https://b.test:1443'];
    const client = new DAPISubscriptionClient({ network: 'testnet', dapiAddresses: dup });
    const sub = await startReady(client);

    expect(nodeClients().map((c) => c.options.dapiAddresses[0].host).sort()).toEqual(['a.test', 'b.test']);
    liveStreams()[0].emit('data', lockMessage(TXID));
    await sub.wait();
  });
});
