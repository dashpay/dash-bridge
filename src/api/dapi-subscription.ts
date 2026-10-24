/* eslint-disable @typescript-eslint/no-explicit-any */

import DAPIClientModule from '@dashevo/dapi-client';
import dashcoreLib from '@dashevo/dashcore-lib';
import { getNetwork } from '../config.js';
import { hash160 } from '../crypto/hash.js';
import { describeIslock } from '../utils/islock-debug.js';
import { fetchPlatformStatus, type PlatformStatus } from '../platform/status.js';

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
/** Longest subscribeForInstantSendLock waits for a first stream message before returning. */
export const ISLOCK_READINESS_CAP_MS = 3000;

const CLIENT_OPTIONS = { timeout: 30000, retries: 3 };

interface DapiAddress {
  protocol: string;
  host: string;
  port: number;
}

interface NodeSlot {
  client?: any;
  stream?: any;
  failed: boolean;
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export class DAPISubscriptionClient {
  readonly network: string;
  private readonly dapiClient: any;
  private readonly nodeAddresses: DapiAddress[];
  // Aborts of in-flight multi-node subscriptions. DAPIClient.disconnect() does
  // not cancel streams, so disconnect() must stop these to close the per-node clients.
  private readonly activeSubscriptions = new Set<() => void>();

  constructor(config: DAPISubscriptionConfig) {
    this.network = config.network;
    const options: any = { ...CLIENT_OPTIONS };
    this.nodeAddresses = [];
    if (config.dapiAddresses?.length) {
      // DAPIClient expects address objects { host, port, protocol }, not URL strings.
      // Our configs store URLs (https://host:port) for EvoSDK compatibility, so
      // parse them here.
      const parsed: DapiAddress[] = config.dapiAddresses.map((addr) => {
        const url = new URL(addr);
        return {
          protocol: url.protocol.replace(':', ''),
          host: url.hostname,
          port: url.port ? parseInt(url.port, 10) : 443,
        };
      });
      options.dapiAddresses = parsed;
      // A repeated address would put two "distinct" streams on one node.
      this.nodeAddresses = [...new Map(parsed.map((a) => [`${a.host}:${a.port}`, a])).values()];
    } else {
      options.network = config.network === 'mainnet' ? 'mainnet' : 'testnet';
    }
    this.dapiClient = new DAPIClientClass(options);
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

    onProgress?.('Getting current block height...');
    const currentHeight: number = await this.dapiClient.core.getBestBlockHeight();
    console.log('[islock-sub] Current block height:', currentHeight);
    const fromBlockHeight = Math.max(1, currentHeight - 10);

    if (this.nodeAddresses.length >= 2) {
      return this.subscribeOnMultipleNodes(
        txid, bloomFilter, fromBlockHeight, timeoutMs, onProgress, signal
      );
    }

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
    onProgress?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<{ wait: () => Promise<Uint8Array> }> {
    const nodes = shuffled(this.nodeAddresses);
    const initialCount = Math.min(ISLOCK_CONCURRENT_NODES, nodes.length);
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
        const client = slot.client;
        if (!client) return;
        try {
          Promise.resolve(client.disconnect()).catch(() => {});
        } catch { /* ignore */ }
      };

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        clearTimeout(readyTimerId);
        this.activeSubscriptions.delete(onAbort);
        signal?.removeEventListener('abort', onAbort);
        for (const slot of [...slots]) release(slot);
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
          slot.client = new DAPIClientClass({ ...CLIENT_OPTIONS, dapiAddresses: [address] });
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
              if (bytes) finish(() => resolve(bytes));
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
    try { await this.dapiClient.disconnect(); } catch { /* ignore */ }
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
    // By config type, not name: an unknown name falls back to the testnet config.
    if (getNetwork(this.network).type === 'testnet') {
      return fetchPlatformStatus(this.network);
    }

    const status = await this.dapiClient.platform.getStatus();

    const chain = status.getChainStatus?.() ?? status.chain;
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
