/* eslint-disable @typescript-eslint/no-explicit-any */

import DAPIClientModule from '@dashevo/dapi-client';
import dashcoreLib from '@dashevo/dashcore-lib';
import type { NetworkConfig } from '../config.js';
import type { TxInfo, UTXO } from '../types.js';
import { DAPISubscriptionClient } from './dapi-subscription.js';
import { withRetry, type RetryOptions } from '../utils/retry.js';
import { abortableSleep } from '../utils/sleep.js';

const DAPIClientClass = (DAPIClientModule as any).default || DAPIClientModule;
const Address = (dashcoreLib as any).Address;

/**
 * Core access for the bridge. All reads and writes go through DAPI gRPC;
 * there is no explorer, Insight, or application-owned broadcast relay in
 * this path. DAPI's normal seed/SML rotation remains available for public
 * networks, while devnets can provide explicit masternode addresses.
 */
export class CoreClient {
  private readonly dapi: any;
  private readonly subscriptions: DAPISubscriptionClient;

  constructor(config: NetworkConfig) {
    const options: any = { timeout: 30000, retries: 3 };
    if (config.dapiAddresses?.length) {
      options.dapiAddresses = config.dapiAddresses.map((address) => {
        const url = new URL(address);
        return {
          protocol: url.protocol.replace(':', ''),
          host: url.hostname,
          port: url.port ? Number(url.port) : 443,
        };
      });
    } else {
      options.network = config.type === 'mainnet' ? 'mainnet' : 'testnet';
    }
    this.dapi = new DAPIClientClass(options);
    this.subscriptions = new DAPISubscriptionClient({
      network: config.type === 'mainnet' ? 'mainnet' : config.type === 'testnet' ? 'testnet' : config.name,
      dapiAddresses: config.dapiAddresses,
    });
  }

  async getBlockHeight(retryOptions?: RetryOptions): Promise<number> {
    return withRetry(() => this.dapi.core.getBestBlockHeight(), withDapiRetry(retryOptions));
  }

  async getUTXOs(address: string, retryOptions?: RetryOptions): Promise<UTXO[]> {
    const pubKeyHash = this.publicKeyHash(address);
    return this.subscriptions.scanUtxos(pubKeyHash, 5_000, undefined, retryOptions);
  }

  async waitForUtxo(
    address: string,
    minAmount: number,
    timeoutMs = 120000,
    _pollIntervalMs = 3000,
    onProgress?: (remainingMs: number, currentTotal: number) => void,
    onRetry?: RetryOptions['onRetry']
  ): Promise<{ utxo: UTXO | null; totalAmount: number; timedOut: boolean }> {
    const pubKeyHash = this.publicKeyHash(address);
    const started = Date.now();
    const result = await this.subscriptions.waitForUtxo(
      pubKeyHash,
      minAmount,
      timeoutMs,
      (total) => onProgress?.(Math.max(0, timeoutMs - (Date.now() - started)), total),
      onRetry,
    );
    return result;
  }

  async broadcastTransaction(txHex: string, retryOptions?: RetryOptions): Promise<string> {
    return withRetry(
      () => this.dapi.core.broadcastTransaction(Buffer.from(txHex, 'hex')),
      withDapiRetry(retryOptions),
    );
  }

  async getTransaction(txid: string, retryOptions?: RetryOptions, signal?: AbortSignal): Promise<TxInfo> {
    return withRetry(async () => {
      if (signal?.aborted) throw new Error(`Transaction lookup aborted for ${txid}`);
      const result = await this.dapi.core.getTransaction(txid);
      const height = Number(result.getHeight?.() ?? result.height ?? 0);
      const confirmations = Number(result.getConfirmations?.() ?? result.confirmations ?? 0);
      return {
        txid,
        confirmations: Number.isFinite(confirmations) ? confirmations : 0,
        txlock: Boolean(result.isInstantLocked?.() ?? result.instantLocked),
        blockheight: Number.isSafeInteger(height) && height > 0 ? height : undefined,
      };
    }, withDapiRetry(retryOptions));
  }

  async waitForBlockHeight(
    txid: string,
    pollIntervalMs = 5000,
    signal?: AbortSignal,
    onPoll?: (info: TxInfo) => void,
  ): Promise<number> {
    while (!signal?.aborted) {
      try {
        const info = await this.getTransaction(txid, { maxAttempts: 1 }, signal);
        onPoll?.(info);
        if (info.blockheight !== undefined) return info.blockheight;
      } catch {
        // A transaction can take a moment to become visible through DAPI.
      }
      await abortableSleep(pollIntervalMs, signal);
    }
    throw new Error(`Block-height polling aborted for ${txid}`);
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled([
      this.dapi.disconnect(),
      this.subscriptions.disconnect(),
    ]);
  }

  private publicKeyHash(address: string): Uint8Array {
    const parsed = Address.fromString(address);
    if (!parsed?.hashBuffer || parsed.type !== Address.PayToPublicKeyHash) {
      throw new Error(`Unsupported deposit address: ${address}`);
    }
    return new Uint8Array(parsed.hashBuffer);
  }
}

function withDapiRetry(options?: RetryOptions): RetryOptions {
  return {
    ...options,
    // DAPI errors are library-specific and do not consistently expose a
    // browser `TypeError`; retry transport failures with the shared backoff.
    shouldRetry: options?.shouldRetry ?? (() => true),
  };
}
