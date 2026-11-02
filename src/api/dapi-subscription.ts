/* eslint-disable @typescript-eslint/no-explicit-any */

import DAPIClientModule from '@dashevo/dapi-client';
import dapiNetworkConfigs from '@dashevo/dapi-client/lib/networkConfigs.js';
import dashcoreLib from '@dashevo/dashcore-lib';
import { getNetwork } from '../config.js';
import { hash160 } from '../crypto/hash.js';
import { describeIslock } from '../utils/islock-debug.js';
import {
  EvonodeDiscovery,
  parseDapiAddress,
  seedAddresses,
  shuffled,
  type DapiAddress,
} from './evonode-discovery.js';
import {
  fetchPlatformStatus,
  fetchPlatformStatusIfSdkReady,
  type PlatformStatus,
} from '../platform/status.js';

interface BloomFilterStatic {
  create(elements: number, falsePositiveRate: number, nTweak: number, nFlags: number): {
    vData: number[];
    nHashFuncs: number;
    nTweak: number;
    nFlags: number;
    insert(data: Uint8Array | Buffer): void;
  };
  BLOOM_UPDATE_ALL: number;
}

interface InstantLockStatic {
  fromBuffer(buffer: Buffer): { txid: string };
}

const DAPIClientClass = (DAPIClientModule as any).default || DAPIClientModule;
const BloomFilter = (dashcoreLib as any).BloomFilter as BloomFilterStatic;
const InstantLock = (dashcoreLib as any).InstantLock as InstantLockStatic;

export interface DAPISubscriptionConfig {
  network: string;
  dapiAddresses?: string[];
}

/** Distinct evonodes the IS lock stream is opened on at once. */
export const ISLOCK_CONCURRENT_NODES = 3;
/** Total streams opened per subscription, initial ones plus replacements for failed ones. */
export const ISLOCK_MAX_NODE_ATTEMPTS = ISLOCK_CONCURRENT_NODES + 6;
/** Deadline for each node's best-block-height answer before the stream starts. */
export const ISLOCK_HEIGHT_TIMEOUT_MS = 8000;
/** Longest subscribeForInstantSendLock waits for a first stream message before returning. */
export const ISLOCK_READINESS_CAP_MS = 3000;

const CLIENT_OPTIONS = { timeout: 30000, retries: 3 };

interface NodeSlot {
  client?: any;
  stream?: any;
  failed: boolean;
}

export class DAPISubscriptionClient {
  readonly network: string;
  // Exactly one of these is set: testnet discovers its evonodes, every other
  // network uses one client over its configured addresses (or, on mainnet,
  // dapi-client's default seeds).
  private readonly discovery?: EvonodeDiscovery;
  private readonly fixedClient?: any;
  private readonly nodeAddresses: DapiAddress[];
  // Aborts of in-flight multi-node subscriptions. DAPIClient.disconnect() does
  // not cancel streams, so disconnect() must stop these to close the per-node clients.
  private readonly activeSubscriptions = new Set<() => void>();

  constructor(config: DAPISubscriptionConfig) {
    this.network = config.network;
    this.nodeAddresses = [];
    if (config.dapiAddresses?.length) {
      // DAPIClient expects address objects { host, port, protocol }, not URL strings.
      // Our configs store URLs (https://host:port) for EvoSDK compatibility, so
      // parse them here.
      const parsed = config.dapiAddresses.map(parseDapiAddress);
      // A repeated address would put two "distinct" streams on one node.
      this.nodeAddresses = [...new Map(parsed.map((a) => [`${a.host}:${a.port}`, a])).values()];
      this.fixedClient = new DAPIClientClass({ ...CLIENT_OPTIONS, dapiAddresses: parsed });
    } else if (getNetwork(config.network).type === 'testnet') {
      // Seeds come from the published dapi-client, so they follow its releases.
      this.discovery = new EvonodeDiscovery({
        network: 'testnet',
        seeds: seedAddresses(dapiNetworkConfigs.testnet.seeds),
        createClient: (dapiAddresses) => new DAPIClientClass({ ...CLIENT_OPTIONS, dapiAddresses }),
      });
    } else {
      this.fixedClient = new DAPIClientClass({
        ...CLIENT_OPTIONS,
        network: config.network === 'mainnet' ? 'mainnet' : 'testnet',
      });
    }
  }

  /**
   * Client for calls that may go to any node. On testnet it covers the
   * evonodes found by the last discovery, so it is undefined before the
   * first subscription.
   */
  private get dapiClient(): any {
    return this.discovery ? this.discovery.sharedClient : this.fixedClient;
  }

  /**
   * Start syncing the testnet masternode list so the first IS lock
   * subscription doesn't wait for it. Never rejects; resolves at once on
   * networks with configured addresses.
   */
  warmEvonodeDiscovery(): Promise<void> {
    return this.discovery ? this.discovery.warm() : Promise.resolve();
  }

  /** A client pinned to one node, so streams and height probes can't land on the same node twice. */
  private createNodeClient(address: DapiAddress): any {
    return new DAPIClientClass({ ...CLIENT_OPTIONS, dapiAddresses: [address] });
  }

  private tryCreateNodeClient(address: DapiAddress): any | undefined {
    try {
      return this.createNodeClient(address);
    } catch (error) {
      console.warn(`[islock-sub] could not create client for ${address.host}:${address.port}:`, error);
      return undefined;
    }
  }

  private disconnectQuietly(client: any | undefined): void {
    if (!client) return;
    try {
      Promise.resolve(client.disconnect()).catch(() => {});
    } catch { /* ignore */ }
  }

  /**
   * Ask every client for the best block height at once and take the first
   * success. Each request has its own deadline because a blackholed node never
   * answers and the transport only gives up after ~75 s. Rejects only when
   * every node failed (same message shape as a failed stream subscription), or
   * when `signal` aborts.
   */
  private raceBestBlockHeight(
    txid: string,
    clients: Array<any | undefined>,
    signal?: AbortSignal,
    // Nodes that already failed in earlier batches, for the error message.
    triedBefore = 0
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let done = false;
      let failures = 0;
      const timers = new Set<ReturnType<typeof setTimeout>>();

      const settle = (fn: () => void): void => {
        if (done) return;
        done = true;
        for (const timer of timers) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = (): void => {
        settle(() => reject(new Error(`InstantSend lock subscription aborted for ${txid}`)));
      };
      const failOne = (error: unknown): void => {
        if (done) return;
        console.warn('[islock-sub] block height request failed:', error);
        if (++failures < clients.length) return;
        const reason = error instanceof Error ? error.message : String(error);
        settle(() => reject(new Error(
          `InstantSend lock subscription failed for ${txid}: ${triedBefore + clients.length} nodes tried, last error: ${reason}`
        )));
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      for (const client of clients) {
        if (!client) {
          failOne(new Error('Could not create a client for the node'));
          continue;
        }
        let answered = false;
        const timer = setTimeout(() => {
          if (answered) return;
          answered = true;
          failOne(new Error(`getBestBlockHeight timed out after ${ISLOCK_HEIGHT_TIMEOUT_MS}ms`));
        }, ISLOCK_HEIGHT_TIMEOUT_MS);
        timers.add(timer);
        Promise.resolve()
          .then(() =>
            // retries 0 + a gRPC deadline: no hidden background retries after our own
            // deadline has already counted this node as failed.
            client.core.getBestBlockHeight({ retries: 0, timeout: ISLOCK_HEIGHT_TIMEOUT_MS })
          )
          .then((height: unknown) => {
            if (answered) return;
            answered = true;
            if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
              failOne(new Error(`Invalid block height ${String(height)}`));
              return;
            }
            settle(() => resolve(height));
          }, (error: unknown) => {
            if (answered) return;
            answered = true;
            failOne(error);
          });
      }
    });
  }

  private createBloomFilter(
    pubKeyHash: Uint8Array,
    outpoint: { txid: string; vout: number }
  ): { vData: Uint8Array; nHashFuncs: number; nTweak: number; nFlags: number } {
    const nTweak = Math.floor(Math.random() * 0xffffffff);
    const filter = BloomFilter.create(3, 0.01, nTweak, BloomFilter.BLOOM_UPDATE_ALL);

    filter.insert(Buffer.from(pubKeyHash));

    const scriptPubKey = Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]),
      Buffer.from(pubKeyHash),
      Buffer.from([0x88, 0xac]),
    ]);
    filter.insert(scriptPubKey);

    const txidBytes = Buffer.from(outpoint.txid, 'hex').reverse();
    const voutBytes = Buffer.alloc(4);
    voutBytes.writeUInt32LE(outpoint.vout, 0);
    filter.insert(Buffer.concat([txidBytes, voutBytes]));

    return {
      vData: new Uint8Array(filter.vData),
      nHashFuncs: filter.nHashFuncs,
      nTweak: filter.nTweak,
      nFlags: filter.nFlags,
    };
  }

  private parseInstantLockTxid(islockBytes: Uint8Array): string | null {
    try {
      return InstantLock.fromBuffer(Buffer.from(islockBytes)).txid;
    } catch {
      return null;
    }
  }

  /**
   * Open a gRPC subscription stream for the bloom filter and return a handle
   * whose `.wait()` resolves with the matching IS lock bytes.
   *
   * The gRPC stream is established before this method returns, so the caller
   * can broadcast the watched tx afterwards without missing a fast IS lock
   * (dashd's TransactionsWithProofs does not replay historical IS locks).
   */
  async subscribeForInstantSendLock(
    txid: string,
    publicKey: Uint8Array,
    utxo: { txid: string; vout: number },
    timeoutMs: number = 60000,
    onProgress?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<{ wait: () => Promise<Uint8Array> }> {
    if (signal?.aborted) {
      throw new Error(`InstantSend lock subscription aborted for ${txid}`);
    }

    onProgress?.('Creating bloom filter...');
    const bloomFilter = this.createBloomFilter(hash160(publicKey), utxo);

    if (this.discovery || this.nodeAddresses.length >= 2) {
      // The shared client picks one random node and waits out its full connect
      // timeout (~75 s in browsers) when that node is unreachable, with nothing
      // broadcast meanwhile. Ask the nodes the streams will use, all at once.
      // disconnect() (e.g. a network switch) must also stop these waits, or the
      // streams below would open on the network being left.
      const raceAbort = new AbortController();
      const abortRace = (): void => raceAbort.abort();
      if (signal?.aborted) abortRace();
      signal?.addEventListener('abort', abortRace, { once: true });
      this.activeSubscriptions.add(abortRace);
      let nodes: DapiAddress[] = [];
      let clients: Array<any | undefined> = [];
      let currentHeight: number;
      try {
        let candidates = this.nodeAddresses;
        if (this.discovery) {
          onProgress?.('Finding evonodes...');
          candidates = await this.discovery.getNodes(raceAbort.signal);
          console.log(`[islock-sub] discovered ${candidates.length} evonodes`);
        }
        onProgress?.('Getting current block height...');
        nodes = shuffled(candidates);
        // A batch where no node answers moves on to the next one, up to the
        // same node budget the streams have; the streams then start from the
        // batch that answered, skipping nodes already known to be down.
        const probeLimit = Math.min(nodes.length, ISLOCK_MAX_NODE_ATTEMPTS);
        let offset = 0;
        for (;;) {
          clients = nodes
            .slice(offset, Math.min(offset + ISLOCK_CONCURRENT_NODES, probeLimit))
            .map((address) => this.tryCreateNodeClient(address));
          try {
            currentHeight = await this.raceBestBlockHeight(txid, clients, raceAbort.signal, offset);
            break;
          } catch (error) {
            if (raceAbort.signal.aborted) throw error;
            for (const client of clients) this.disconnectQuietly(client);
            clients = [];
            offset += ISLOCK_CONCURRENT_NODES;
            if (offset >= probeLimit) throw error;
            console.warn(`[islock-sub] no block height from ${offset} nodes; asking the next ones`);
          }
        }
        nodes = nodes.slice(offset);
      } catch (error) {
        for (const client of clients) this.disconnectQuietly(client);
        if (raceAbort.signal.aborted) {
          throw new Error(`InstantSend lock subscription aborted for ${txid}`);
        }
        throw error;
      } finally {
        this.activeSubscriptions.delete(abortRace);
        signal?.removeEventListener('abort', abortRace);
      }
      console.log('[islock-sub] Current block height:', currentHeight);
      return this.subscribeOnMultipleNodes(
        txid, bloomFilter, Math.max(1, currentHeight - 10), timeoutMs, nodes, clients, onProgress, signal
      );
    }

    onProgress?.('Getting current block height...');
    const currentHeight: number = await this.dapiClient.core.getBestBlockHeight();
    console.log('[islock-sub] Current block height:', currentHeight);
    const fromBlockHeight = Math.max(1, currentHeight - 10);

    onProgress?.(`Subscribing from block ${fromBlockHeight}...`);
    const stream = await this.dapiClient.core.subscribeToTransactionsWithProofs(
      bloomFilter,
      { fromBlockHeight, count: 0 }
    );
    console.log(`[islock-sub] Subscribed from block ${fromBlockHeight}, watching for txid ${txid}`);

    onProgress?.('Listening for InstantSend lock...');

    const lockPromise = new Promise<Uint8Array>((resolve, reject) => {
      const onAbort = (): void => {
        finish(() => reject(new Error(`InstantSend lock subscription aborted for ${txid}`)));
      };

      const finish = (fn: () => void): void => {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
        try { stream.cancel(); } catch { /* ignore */ }
        fn();
      };

      const timeoutId = setTimeout(() => {
        finish(() => reject(new Error(`Timeout waiting for InstantSend lock for ${txid} after ${timeoutMs}ms`)));
      }, timeoutMs);

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      stream.on('data', (response: unknown) => {
        const bytes = this.findMatchingLock(response, txid, onProgress);
        if (bytes) finish(() => resolve(bytes));
      });

      stream.on('error', (error: Error) => {
        console.error('[islock-sub] stream error:', error);
        finish(() => reject(error));
      });
      stream.on('end', () => {
        console.warn('[islock-sub] stream ended');
        finish(() => reject(new Error(`Stream ended before receiving InstantSend lock for ${txid}`)));
      });
    });

    // Avoid unhandled-rejection warnings if the caller never awaits .wait()
    lockPromise.catch(() => {});

    return { wait: () => lockPromise };
  }

  /** Returns the bytes of the IS lock for `txid` carried by a stream message, if any. */
  private findMatchingLock(
    response: unknown,
    txid: string,
    onProgress?: (message: string) => void
  ): Uint8Array | null {
    try {
      const islockMessages = (response as any).getInstantSendLockMessages?.();
      const hasIslocks = !!islockMessages;
      const hasMerkleBlock = !!(response as any).getRawMerkleBlock?.()?.length;
      const hasRawTxs = !!(response as any).getRawTransactions?.()?.getTransactionsList?.()?.length;
      console.log(`[islock-sub] stream data: islocks=${hasIslocks} merkleBlock=${hasMerkleBlock} rawTxs=${hasRawTxs}`);
      if (!islockMessages) return null;
      const messages = islockMessages.getMessagesList_asU8?.() || islockMessages.getMessagesList?.();
      if (!messages || messages.length === 0) return null;
      console.log(`[islock-sub] received ${messages.length} IS lock(s) in stream message`);
      for (const msgBytes of messages) {
        const bytes = msgBytes instanceof Uint8Array ? msgBytes : new Uint8Array(msgBytes);
        const lockTxid = this.parseInstantLockTxid(bytes);
        console.log(`[islock-sub] IS lock txid=${lockTxid} (want ${txid})`);
        if (lockTxid === txid) {
          onProgress?.('InstantSend lock received!');
          const debug = describeIslock(bytes, 'dapi-subscription');
          console.log('[islock-debug] IS lock received via gRPC subscription:', debug);
          return bytes;
        }
      }
    } catch (error) {
      console.warn('Error processing stream data:', error);
    }
    return null;
  }

  /**
   * Subscribe on several distinct evonodes at once and take the first matching
   * IS lock. A single random node can be dead (the stream then errors ~12 s
   * after connecting, long after the tx was broadcast) or can silently drop the
   * lock, so each node gets its own one-address client: a shared client would
   * pick nodes at random and could land on the same one twice.
   *
   * subscribeToTransactionsWithProofs resolves before any connection exists, so
   * readiness is approximated: return once any stream delivers a message (the
   * server replays recent blocks, usually within ~1 s) or after the readiness
   * cap, whichever comes first. The remaining streams keep connecting. If every
   * node attempt has already failed by then, this rejects instead of returning
   * a handle, so nothing is broadcast without a listener.
   */
  private async subscribeOnMultipleNodes(
    txid: string,
    bloomFilter: ReturnType<DAPISubscriptionClient['createBloomFilter']>,
    fromBlockHeight: number,
    timeoutMs: number,
    nodes: DapiAddress[],
    // Clients already created for nodes[0..n) while fetching the height; the
    // streams reuse them. Entries are undefined where creation threw.
    initialClients: Array<any | undefined>,
    onProgress?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<{ wait: () => Promise<Uint8Array> }> {
    const initialCount = initialClients.length;
    const subscribedAt = Date.now();
    const unadopted = new Set(initialClients.filter(Boolean));
    onProgress?.(`Subscribing from block ${fromBlockHeight} on ${initialCount} nodes...`);

    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const readyTimerId = setTimeout(markReady, ISLOCK_READINESS_CAP_MS);
    // Set when every node attempt failed. Only read once, right after the
    // readiness wait, to fail before the caller broadcasts.
    let allFailed: Error | undefined;

    const lockPromise = new Promise<Uint8Array>((resolve, reject) => {
      const slots = new Set<NodeSlot>();
      let settled = false;
      // Streams opened so far; also the index of the next untried node.
      let attempts = 0;

      const cancelStream = (stream: any): void => {
        try { stream?.cancel(); } catch { /* ignore */ }
      };

      const release = (slot: NodeSlot): void => {
        slots.delete(slot);
        cancelStream(slot.stream);
        this.disconnectQuietly(slot.client);
      };

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        clearTimeout(readyTimerId);
        this.activeSubscriptions.delete(onAbort);
        signal?.removeEventListener('abort', onAbort);
        for (const slot of [...slots]) release(slot);
        // Height-probe clients that never got a stream (aborted before opening).
        for (const client of unadopted) this.disconnectQuietly(client);
        unadopted.clear();
        markReady();
        fn();
      };

      const onAbort = (): void => {
        finish(() => reject(new Error(`InstantSend lock subscription aborted for ${txid}`)));
      };

      const timeoutId = setTimeout(() => {
        finish(() => reject(new Error(`Timeout waiting for InstantSend lock for ${txid} after ${timeoutMs}ms`)));
      }, timeoutMs);

      const openNode = (): void => {
        const address = nodes[attempts++];
        if (!address) return;
        const slot: NodeSlot = { failed: false };
        slots.add(slot);

        const fail = (error: unknown): void => {
          if (settled || slot.failed) return;
          slot.failed = true;
          release(slot);
          if (attempts < nodes.length && attempts < ISLOCK_MAX_NODE_ATTEMPTS) {
            openNode();
          } else if (slots.size === 0) {
            const reason = error instanceof Error ? error.message : String(error);
            const exhausted = new Error(
              `InstantSend lock subscription failed for ${txid}: ${attempts} nodes tried, last error: ${reason}`
            );
            allFailed = exhausted;
            finish(() => reject(exhausted));
          }
        };

        console.log(`[islock-sub] opening stream on ${address.host}:${address.port} (attempt ${attempts})`);
        try {
          slot.client = initialClients[attempts - 1] ?? this.createNodeClient(address);
          unadopted.delete(slot.client);
          Promise.resolve(
            slot.client.core.subscribeToTransactionsWithProofs(bloomFilter, { fromBlockHeight, count: 0 })
          ).then((stream: any) => {
            if (settled || slot.failed) {
              cancelStream(stream);
              return;
            }
            slot.stream = stream;
            stream.on('data', (response: unknown) => {
              if (settled) return;
              markReady();
              const bytes = this.findMatchingLock(response, txid, onProgress);
              if (!bytes) return;
              console.log(
                `[islock-sub] IS lock for ${txid} from ${address.host}:${address.port} after ${Date.now() - subscribedAt} ms since subscribe`
              );
              finish(() => resolve(bytes));
            });
            // Listeners stay attached after cancel(): Node gRPC streams emit
            // 'error' on cancel, which would throw if nothing were listening.
            // The browser build reports one failure through both 'error' and
            // 'end'; slot.failed makes the second a no-op.
            stream.on('error', (error: Error) => {
              if (settled || slot.failed) return;
              console.error(`[islock-sub] stream error on ${address.host}:${address.port}:`, error);
              fail(error);
            });
            stream.on('end', () => {
              if (settled || slot.failed) return;
              console.warn(`[islock-sub] stream ended on ${address.host}:${address.port}`);
              fail(new Error(`Stream ended before receiving InstantSend lock for ${txid}`));
            });
          }).catch(fail);
        } catch (error) {
          fail(error);
        }
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.activeSubscriptions.add(onAbort);

      for (let i = 0; i < initialCount && !settled; i++) openNode();
    });

    // Avoid unhandled-rejection warnings if the caller never awaits .wait()
    lockPromise.catch(() => {});

    await ready;
    // The caller broadcasts the asset lock as soon as this returns, so a
    // subscription with no live stream must stop the flow before funds are
    // committed. Failures after this point surface through wait().
    if (allFailed) throw allFailed;
    return { wait: () => lockPromise };
  }

  async waitForInstantSendLock(
    txid: string,
    publicKey: Uint8Array,
    utxo: { txid: string; vout: number },
    timeoutMs: number = 60000,
    onProgress?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const sub = await this.subscribeForInstantSendLock(txid, publicKey, utxo, timeoutMs, onProgress, signal);
    return sub.wait();
  }

  async disconnect(): Promise<void> {
    for (const abort of [...this.activeSubscriptions]) abort();
    if (this.discovery) {
      await this.discovery.disconnect();
      return;
    }
    try { await this.fixedClient.disconnect(); } catch { /* ignore */ }
  }

  /**
   * Read the chain-locked Dash Core block height directly from Platform
   * (`chain.coreChainLockedHeight` of the Platform status).
   *
   * Devnets go straight to dapi-client (`platform.getStatus()`) rather than
   * `sdk.system.status()` because the wasm SDK in trusted mode can return
   * testnet-cached values there, while this path is authoritative for
   * whatever masternode the dapiAddresses point at. Testnet uses the SDK;
   * see {@link getPlatformStatus}.
   *
   * @returns the chain-locked height, or `undefined` if the masternode
   *   reports no chain-lock yet.
   */
  async getCoreChainLockedHeight(): Promise<number | undefined> {
    const status = await this.getPlatformStatus();
    return status.coreChainLockedHeight;
  }

  /**
   * Read Platform/Tenderdash status. Surfaces the chain-locked Core height
   * plus the latest Platform block height and its timestamp, which together
   * let callers detect a stalled Platform consensus (Core advancing while
   * Tenderdash is stuck). Fields are `undefined` when the masternode doesn't
   * report them.
   *
   * Testnet reads through the EvoSDK (see `fetchPlatformStatus` for why);
   * every other network keeps the dapi-client gRPC call.
   */
  async getPlatformStatus(): Promise<PlatformStatus> {
    if (this.readsStatusViaSdk()) {
      return fetchPlatformStatus(this.network);
    }
    return this.fetchStatusViaDapiClient();
  }

  /**
   * Passive variant of {@link getPlatformStatus} for background health polling.
   * On testnet it resolves `undefined`, without loading the EvoSDK, until a
   * funding flow has started connecting it (and while that connect is in
   * flight); from then on it reads, and failures reject. Other networks read
   * exactly as getPlatformStatus does (dapi-client needs no SDK download).
   */
  async peekPlatformStatus(): Promise<PlatformStatus | undefined> {
    if (this.readsStatusViaSdk()) {
      return fetchPlatformStatusIfSdkReady(this.network);
    }
    return this.fetchStatusViaDapiClient();
  }

  /** By config type, not name: an unknown name falls back to the testnet config. */
  private readsStatusViaSdk(): boolean {
    return getNetwork(this.network).type === 'testnet';
  }

  private async fetchStatusViaDapiClient(): Promise<PlatformStatus> {
    const status = await this.dapiClient.platform.getStatus();

    const chain = status.getChainStatus?.() ?? status.chain;
    // dapi-client 5 returns null for sections a node leaves out, where 3.x
    // threw. A status without its chain section says nothing about Platform,
    // so keep treating it as a failed read rather than a healthy one.
    if (!chain) throw new Error('Platform status has no chain section');
    const clhRaw = chain?.getCoreChainLockedHeight?.() ?? chain?.coreChainLockedHeight;
    const lbhRaw = chain?.getLatestBlockHeight?.() ?? chain?.latestBlockHeight;

    const time = status.getTimeStatus?.() ?? status.time;
    const blockTimeRaw = time?.getBlockTime?.() ?? time?.block;

    const toNum = (v: unknown): number | undefined =>
      v === null || v === undefined ? undefined : Number(v);

    return {
      coreChainLockedHeight: toNum(clhRaw),
      latestBlockHeight: toNum(lbhRaw),
      latestBlockTimeMs: toNum(blockTimeRaw),
    };
  }

  /**
   * Fetch tx lock status from DAPI gRPC `getTransaction`. Returns
   * `instantLocked`/`chainLocked` booleans (the endpoint does NOT return the
   * IS lock bytes, so this is only useful as a diagnostic tripwire to detect
   * cases where DAPI silently dropped the IS lock we needed from the
   * bloom-filter subscription).
   *
   * Returns `null` if the tx isn't known yet (not in mempool, not mined).
   */
  async getTransactionLockStatus(
    txid: string
  ): Promise<{ instantLocked: boolean; chainLocked: boolean; height: number } | null> {
    try {
      const response = await this.dapiClient.core.getTransaction(txid);
      return {
        instantLocked: !!response.isInstantLocked?.(),
        chainLocked: !!response.isChainLocked?.(),
        height: Number(response.getHeight?.() ?? 0),
      };
    } catch {
      return null;
    }
  }
}
