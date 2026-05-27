import { DAPIClient, type DAPIConfig } from './dapi.js';
import { DAPISubscriptionClient, type DAPISubscriptionConfig } from './dapi-subscription.js';
import type { RetryOptions } from '../utils/retry.js';

export interface IslockServiceConfig {
  network: string;
  rpcUrl?: string;
  dapiAddresses?: string[];
}

export class IslockService {
  private readonly jsonRpcClient: DAPIClient;
  private readonly subscriptionClient: DAPISubscriptionClient;
  private readonly hasJsonRpc: boolean;

  constructor(config: IslockServiceConfig) {
    const jsonRpcConfig: DAPIConfig = { network: config.network, rpcUrl: config.rpcUrl };
    this.jsonRpcClient = new DAPIClient(jsonRpcConfig);
    this.hasJsonRpc = this.jsonRpcClient.hasRpcUrl;

    const subConfig: DAPISubscriptionConfig = {
      network: config.network,
      dapiAddresses: config.dapiAddresses,
    };
    this.subscriptionClient = new DAPISubscriptionClient(subConfig);
  }

  /**
   * Open IS lock sources (DAPI bloom subscription + optional JSON-RPC polling)
   * before broadcasting. Returns a handle whose `.wait()` resolves with the
   * IS lock bytes once available. This avoids the race where dashd signs the
   * IS lock between broadcast and subscribe (subscriptions don't replay
   * historical IS locks).
   */
  async subscribeForInstantSendLock(
    txid: string,
    publicKey: Uint8Array,
    utxo: { txid: string; vout: number },
    timeoutMs: number = 60000,
    onRetry?: RetryOptions['onRetry'],
    onProgress?: (message: string) => void
  ): Promise<{ wait: () => Promise<Uint8Array> }> {
    if (!this.hasJsonRpc) {
      // DAPI subscription only — establish the stream, then return.
      return this.subscriptionClient.subscribeForInstantSendLock(
        txid,
        publicKey,
        utxo,
        timeoutMs,
        onProgress
      );
    }

    // Race JSON-RPC polling against DAPI subscription — first success wins.
    // Each source gets its own AbortController so the loser is cancelled as
    // soon as the race settles.
    const jsonRpcController = new AbortController();
    const dapiController = new AbortController();

    const dapiSub = await this.subscriptionClient.subscribeForInstantSendLock(
      txid,
      publicKey,
      utxo,
      timeoutMs,
      onProgress,
      dapiController.signal
    );

    const jsonRpcPromise = this.jsonRpcClient.waitForInstantSendLock(
      txid,
      timeoutMs,
      onRetry,
      jsonRpcController.signal
    );

    jsonRpcPromise.catch(() => {});
    const dapiPromise = dapiSub.wait();
    dapiPromise.catch(() => {});

    const raceStart = Date.now();
    const tagged = async (
      source: string,
      promise: Promise<Uint8Array>
    ): Promise<{ source: string; bytes: Uint8Array }> => {
      const bytes = await promise;
      return { source, bytes };
    };

    const racePromise = (async (): Promise<Uint8Array> => {
      try {
        const winner = await Promise.any([
          tagged('json-rpc', jsonRpcPromise),
          tagged('dapi-subscription', dapiPromise),
        ]);
        const elapsedMs = Date.now() - raceStart;
        console.log(
          `[islock-debug] IS lock race won by ${winner.source} for txid=${txid} in ${elapsedMs}ms`
        );
        return winner.bytes;
      } catch (error) {
        if (error instanceof AggregateError) {
          throw new Error(
            `All IS lock sources failed: ${error.errors.map((e) => (e as Error).message).join('; ')}`
          );
        }
        throw error;
      } finally {
        jsonRpcController.abort();
        dapiController.abort();
      }
    })();
    racePromise.catch(() => {});

    return { wait: () => racePromise };
  }

  async waitForInstantSendLock(
    txid: string,
    publicKey: Uint8Array,
    utxo: { txid: string; vout: number },
    timeoutMs: number = 60000,
    onRetry?: RetryOptions['onRetry'],
    onProgress?: (message: string) => void
  ): Promise<Uint8Array> {
    const sub = await this.subscribeForInstantSendLock(txid, publicKey, utxo, timeoutMs, onRetry, onProgress);
    return sub.wait();
  }

  /**
   * Direct gRPC read of the Platform chain-locked Dash Core height.
   * Used by the chainlock fallback — see DAPISubscriptionClient
   * for why this bypasses `sdk.system.status()`.
   */
  async getCoreChainLockedHeight(): Promise<number | undefined> {
    return this.subscriptionClient.getCoreChainLockedHeight();
  }

  async disconnect(): Promise<void> {
    await this.subscriptionClient.disconnect();
  }
}
