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
   * Open the IS lock source before broadcasting and return a handle whose
   * `.wait()` resolves with the IS lock bytes once available. Devnets without
   * RPC use the DAPI bloom subscription, which must be established before
   * broadcast because subscriptions don't replay historical IS locks.
   * Mainnet/testnet use JSON-RPC polling, which can recover by txid and avoids
   * browser-hostile dapi-client stream discovery.
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

    // JSON-RPC backed networks (mainnet/testnet) should not touch dapi-client
    // stream setup here. Browser seed/SML discovery can fail on TLS-hostname
    // validation and report "No available addresses", which would block the
    // broadcast even though the RPC islock endpoint is sufficient.
    const jsonRpcController = new AbortController();
    onProgress?.('Polling InstantSend lock...');

    const jsonRpcPromise = this.jsonRpcClient.waitForInstantSendLock(
      txid,
      timeoutMs,
      onRetry,
      jsonRpcController.signal
    );

    const raceStart = Date.now();
    const waitPromise = (async (): Promise<Uint8Array> => {
      try {
        const bytes = await jsonRpcPromise;
        const elapsedMs = Date.now() - raceStart;
        console.log(
          `[islock-debug] IS lock received via json-rpc for txid=${txid} in ${elapsedMs}ms`
        );
        return bytes;
      } finally {
        jsonRpcController.abort();
      }
    })();
    waitPromise.catch(() => {});

    return { wait: () => waitPromise };
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
