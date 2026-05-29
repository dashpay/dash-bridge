/* eslint-disable @typescript-eslint/no-explicit-any */

import DAPIClientModule from '@dashevo/dapi-client';
import dashcoreLib from '@dashevo/dashcore-lib';
import { hash160 } from '../crypto/hash.js';
import { describeIslock } from '../utils/islock-debug.js';

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

export class DAPISubscriptionClient {
  readonly network: string;
  private readonly dapiClient: any;

  constructor(config: DAPISubscriptionConfig) {
    this.network = config.network;
    const options: any = { timeout: 30000, retries: 3 };
    if (config.dapiAddresses?.length) {
      // DAPIClient expects address objects { host, port, protocol }, not URL strings.
      // Our configs store URLs (https://host:port) for EvoSDK compatibility, so
      // parse them here.
      options.dapiAddresses = config.dapiAddresses.map((addr) => {
        const url = new URL(addr);
        return {
          protocol: url.protocol.replace(':', ''),
          host: url.hostname,
          port: url.port ? parseInt(url.port, 10) : 443,
        };
      });
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
        try {
          const islockMessages = (response as any).getInstantSendLockMessages?.();
          const hasIslocks = !!islockMessages;
          const hasMerkleBlock = !!(response as any).getRawMerkleBlock?.()?.length;
          const hasRawTxs = !!(response as any).getRawTransactions?.()?.getTransactionsList?.()?.length;
          console.log(`[islock-sub] stream data: islocks=${hasIslocks} merkleBlock=${hasMerkleBlock} rawTxs=${hasRawTxs}`);
          if (!islockMessages) return;
          const messages = islockMessages.getMessagesList_asU8?.() || islockMessages.getMessagesList?.();
          if (!messages || messages.length === 0) return;
          console.log(`[islock-sub] received ${messages.length} IS lock(s) in stream message`);
          for (const msgBytes of messages) {
            const bytes = msgBytes instanceof Uint8Array ? msgBytes : new Uint8Array(msgBytes);
            const lockTxid = this.parseInstantLockTxid(bytes);
            console.log(`[islock-sub] IS lock txid=${lockTxid} (want ${txid})`);
            if (lockTxid === txid) {
              onProgress?.('InstantSend lock received!');
              const debug = describeIslock(bytes, 'dapi-subscription');
              console.log('[islock-debug] IS lock received via gRPC subscription:', debug);
              finish(() => resolve(bytes));
              return;
            }
          }
        } catch (error) {
          console.warn('Error processing stream data:', error);
        }
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
    try { await this.dapiClient.disconnect(); } catch { /* ignore */ }
  }

  /**
   * Read the chain-locked Dash Core block height directly from Platform via
   * gRPC (`platform.getStatus()` → `chain.coreChainLockedHeight`).
   *
   * We go straight to dapi-client rather than `sdk.system.status()` because
   * the wasm SDK in trusted mode returns testnet-cached values for this
   * field on devnets, while this path is authoritative for whatever
   * masternode the dapiAddresses point at.
   *
   * @returns the chain-locked height, or `undefined` if the masternode
   *   reports no chain-lock yet.
   */
  async getCoreChainLockedHeight(): Promise<number | undefined> {
    const status = await this.getPlatformStatus();
    return status.coreChainLockedHeight;
  }

  /**
   * Read Platform/Tenderdash status via gRPC `platform.getStatus()`. Surfaces
   * the chain-locked Core height plus the latest Platform block height and its
   * timestamp, which together let callers detect a stalled Platform consensus
   * (Core advancing while Tenderdash is stuck). Fields are `undefined` when the
   * masternode doesn't report them.
   */
  async getPlatformStatus(): Promise<{
    coreChainLockedHeight?: number;
    latestBlockHeight?: number;
    latestBlockTimeMs?: number;
  }> {
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
