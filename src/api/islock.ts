import { DAPISubscriptionClient, type DAPISubscriptionConfig } from './dapi-subscription.js';
import type { RetryOptions } from '../utils/retry.js';
import { abortableSleep } from '../utils/sleep.js';
import type { PlatformStatus } from '../platform/status.js';

export interface IslockServiceConfig {
  network: string;
  dapiAddresses?: string[];
}

export class IslockService {
  private readonly subscriptionClient: DAPISubscriptionClient;

  constructor(config: IslockServiceConfig) {
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
   * Public networks without a configured RPC provider request chain recovery.
   * Explicit RPC URLs enable polling by txid without legacy seed discovery.
   */
  async subscribeForInstantSendLock(
    txid: string,
    publicKey: Uint8Array,
    utxo: { txid: string; vout: number },
    timeoutMs: number = 60000,
    onRetry?: RetryOptions['onRetry'],
    onProgress?: (message: string) => void
  ): Promise<{ wait: () => Promise<Uint8Array>; cancel: () => void }> {
    void onRetry;
    // DAPI is the only InstantSend source. Opening the stream before broadcast
    // prevents a fast lock from racing past the browser listener.
    const controller = new AbortController();
    const sub = await this.subscriptionClient.subscribeForInstantSendLock(
      txid, publicKey, utxo, timeoutMs, onProgress, controller.signal
    );
    this.startLockStatusTripwire(txid, controller.signal);
    return {
      cancel: () => controller.abort(),
      wait: async () => {
      try {
          return await sub.wait();
      } finally {
          controller.abort();
      }
      },
    };
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

  /** Platform-observed chain lock, independent of the optional RPC host. */
  async getCoreChainLockedHeight(): Promise<number | undefined> {
    return (await this.getPlatformStatus()).coreChainLockedHeight;
  }

  /** Read Platform status directly from the selected DAPI node set. */
  async getPlatformStatus(): Promise<PlatformStatus> {
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
