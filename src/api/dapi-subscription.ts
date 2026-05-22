/* eslint-disable @typescript-eslint/no-explicit-any */

import DAPIClientModule from '@dashevo/dapi-client';
import dashcoreLib from '@dashevo/dashcore-lib';
import { hash160 } from '../crypto/hash.js';

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
      options.dapiAddresses = config.dapiAddresses;
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

  async waitForInstantSendLock(
    txid: string,
    publicKey: Uint8Array,
    utxo: { txid: string; vout: number },
    timeoutMs: number = 60000,
    onProgress?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    if (signal?.aborted) {
      throw new Error(`InstantSend lock subscription aborted for ${txid}`);
    }

    onProgress?.('Creating bloom filter...');
    const bloomFilter = this.createBloomFilter(hash160(publicKey), utxo);

    onProgress?.('Getting current block height...');
    const currentHeight: number = await this.dapiClient.core.getBestBlockHeight();
    const fromBlockHeight = Math.max(1, currentHeight - 10);

    onProgress?.(`Subscribing from block ${fromBlockHeight}...`);
    const stream = await this.dapiClient.core.subscribeToTransactionsWithProofs(
      bloomFilter,
      { fromBlockHeight, count: 0 }
    );

    onProgress?.('Listening for InstantSend lock...');

    return new Promise<Uint8Array>((resolve, reject) => {
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
          if (!islockMessages) return;
          const messages = islockMessages.getMessagesList_asU8?.() || islockMessages.getMessagesList?.();
          if (!messages || messages.length === 0) return;
          for (const msgBytes of messages) {
            const bytes = msgBytes instanceof Uint8Array ? msgBytes : new Uint8Array(msgBytes);
            if (this.parseInstantLockTxid(bytes) === txid) {
              onProgress?.('InstantSend lock received!');
              finish(() => resolve(bytes));
              return;
            }
          }
        } catch (error) {
          console.warn('Error processing stream data:', error);
        }
      });

      stream.on('error', (error: Error) => finish(() => reject(error)));
      stream.on('end', () => finish(() => reject(new Error(`Stream ended before receiving InstantSend lock for ${txid}`))));
    });
  }

  async disconnect(): Promise<void> {
    try { await this.dapiClient.disconnect(); } catch { /* ignore */ }
  }
}
