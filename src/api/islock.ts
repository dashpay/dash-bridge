import { DAPIClient, type DAPIConfig } from './dapi.js';
import { DAPISubscriptionClient, type DAPISubscriptionConfig } from './dapi-subscription.js';
import type { RetryOptions } from '../utils/retry.js';
import { abortableSleep } from '../utils/sleep.js';

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
   * Diagnostic poller. Watches `getTransaction(txid)` and logs a one-shot
   * warning the first time DAPI reports the tx as IS-locked. If the bloom
   * subscription has not delivered the IS lock by then, the discrepancy is
   * almost certainly the post-mempool-sent race in DAPI's
   * `subscribeToNewTransactions` (matched tx not in `transactionHashesMap`
   * when the IS lock arrives → silently dropped). The poller can't recover
   * the IS lock bytes — only the bloom subscription can — but the warning
   * makes the failure mode visible.
   */
  private startLockStatusTripwire(txid: string, signal: AbortSignal): void {
    void (async () => {
      let warnedInstant = false;
      let warnedChain = false;
      while (!signal.aborted) {
        const status = await this.subscriptionClient
          .getTransactionLockStatus(txid)
          .catch(() => null);
        if (signal.aborted) return;
        if (status) {
          if (status.instantLocked && !warnedInstant) {
            warnedInstant = true;
            console.warn(
              `[islock-tripwire] DAPI reports tx ${txid} is IS-locked, but our bloom subscription has not delivered the IS lock bytes. This is consistent with the DAPI subscribeToNewTransactions race (matched tx absent from transactionHashesMap when the IS lock arrives). Continuing to wait on the bloom subscription.`
            );
          }
          if (status.chainLocked && !warnedChain) {
            warnedChain = true;
            console.warn(
              `[islock-tripwire] DAPI reports tx ${txid} is chain-locked (height ${status.height}); IS lock window is effectively closed. If the bloom subscription does not produce an IS lock soon, the chainlock fallback is the right escape hatch.`
            );
          }
        }
        await abortableSleep(3000, signal);
      }
    })();
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
      const sub = await this.subscriptionClient.subscribeForInstantSendLock(
        txid,
        publicKey,
        utxo,
        timeoutMs,
        onProgress
      );
      const tripwireController = new AbortController();
      this.startLockStatusTripwire(txid, tripwireController.signal);
      return {
        wait: async () => {
          try {
            return await sub.wait();
          } finally {
            tripwireController.abort();
          }
        },
      };
    }

    // Race JSON-RPC polling against DAPI subscription — first success wins.
    // Each source gets its own AbortController so the loser is cancelled as
    // soon as the race settles.
    const jsonRpcController = new AbortController();
    const dapiController = new AbortController();
    const tripwireController = new AbortController();
    this.startLockStatusTripwire(txid, tripwireController.signal);

    // The DAPI bloom subscription is best-effort here: JSON-RPC polling is the
    // reliable path on testnet/mainnet. The subscription's setup hits
    // dapi-client masternode address resolution, which can throw "No available
    // addresses" on those networks (no explicit dapiAddresses). Don't let that
    // abort the whole wait — fall back to JSON-RPC polling alone.
    let dapiSub: { wait: () => Promise<Uint8Array> } | null = null;
    try {
      dapiSub = await this.subscriptionClient.subscribeForInstantSendLock(
        txid,
        publicKey,
        utxo,
        timeoutMs,
        onProgress,
        dapiController.signal
      );
    } catch (error) {
      console.warn(
        `[islock] DAPI bloom subscription unavailable; using JSON-RPC polling only: ${(error as Error).message}`
      );
    }

    const jsonRpcPromise = this.jsonRpcClient.waitForInstantSendLock(
      txid,
      timeoutMs,
      onRetry,
      jsonRpcController.signal
    );

    jsonRpcPromise.catch(() => {});
    const dapiPromise = dapiSub?.wait();
    dapiPromise?.catch(() => {});

    const raceStart = Date.now();
    async function tagged(
      source: string,
      promise: Promise<Uint8Array>
    ): Promise<{ source: string; bytes: Uint8Array }> {
      const bytes = await promise;
      return { source, bytes };
    }

    const racePromise = (async (): Promise<Uint8Array> => {
      const contenders = [tagged('json-rpc', jsonRpcPromise)];
      if (dapiPromise) {
        contenders.push(tagged('dapi-subscription', dapiPromise));
      }
      try {
        const winner = await Promise.any(contenders);
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
        tripwireController.abort();
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

  /**
   * Whether a JSON-RPC endpoint is configured (mainnet/testnet). Devnets have
   * none and must read Platform status over DAPI instead. The network-status
   * poller uses this to avoid the dapi-client seed/SML address resolution,
   * which can't complete in a browser on mainnet/testnet.
   */
  get supportsJsonRpc(): boolean {
    return this.hasJsonRpc;
  }

  /**
   * Core's best chain-lock (height + blockhash) via JSON-RPC. Returns null when
   * no chain lock has been observed yet, or when no JSON-RPC endpoint exists.
   */
  async getBestChainLock(): Promise<{ height: number; blockhash?: string } | null> {
    if (!this.hasJsonRpc) return null;
    return this.jsonRpcClient.getBestChainLock();
  }

  /**
   * Read Platform/Tenderdash status (chain-locked Core height, latest Platform
   * block height + timestamp) over DAPI. Used by the network-health indicator
   * on devnets (which have explicit dapiAddresses).
   */
  async getPlatformStatus(): Promise<{
    coreChainLockedHeight?: number;
    latestBlockHeight?: number;
    latestBlockTimeMs?: number;
  }> {
    return this.subscriptionClient.getPlatformStatus();
  }

  /**
   * Diagnostic helper: ask DAPI directly whether `txid` is currently
   * IS-locked or chain-locked. Returns null if the tx isn't known.
   *
   * The endpoint does NOT return IS lock bytes, so this can't replace the
   * bloom-filter subscription — but it lets us detect cases where DAPI's
   * subscribeToTransactionsWithProofs silently dropped our IS lock (a known
   * race in DAPI's post-mempool-sent handler — see
   * `subscribeToNewTransactions.js`).
   */
  async getTransactionLockStatus(
    txid: string
  ): Promise<{ instantLocked: boolean; chainLocked: boolean; height: number } | null> {
    return this.subscriptionClient.getTransactionLockStatus(txid);
  }

  async disconnect(): Promise<void> {
    await this.subscriptionClient.disconnect();
  }
}
