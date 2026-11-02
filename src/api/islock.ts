import { DAPIClient, type DAPIConfig } from './dapi.js';
import { DAPISubscriptionClient, type DAPISubscriptionConfig } from './dapi-subscription.js';
import type { PlatformStatus } from '../platform/status.js';
import type { RetryOptions } from '../utils/retry.js';
import { abortableSleep } from '../utils/sleep.js';

export interface IslockServiceConfig {
  network: string;
  rpcUrl?: string;
  dapiAddresses?: string[];
}

/** Subscription attempts before broadcast, and the waits between them. */
export const PRE_BROADCAST_RETRY_DELAYS_MS = [5000, 15000];

export class IslockService {
  private readonly jsonRpcClient: DAPIClient;
  private readonly subscriptionClient: DAPISubscriptionClient;
  private readonly hasJsonRpc: boolean;
  // Aborted by disconnect(), so a pre-broadcast retry wait stops with it.
  private readonly lifetime = new AbortController();

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
   * `.wait()` resolves with the IS lock bytes once available. Testnet, mainnet
   * and devnets use the DAPI bloom subscription (testnet and mainnet over the
   * evonodes they discover, devnets over their configured dapiAddresses),
   * which must be established before broadcast because subscriptions don't
   * replay historical IS locks. Only a custom devnet that configures its own
   * rpcUrl polls JSON-RPC instead.
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
      const sub = await this.subscribeBeforeBroadcast(txid, publicKey, utxo, timeoutMs, onProgress);
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

    // A devnet with its own rpcUrl polls it by txid and opens no stream.
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
   * Platform's chain-locked Dash Core height, for the chainlock fallback.
   * See DAPISubscriptionClient.getCoreChainLockedHeight for how it is read.
   */
  async getCoreChainLockedHeight(): Promise<number | undefined> {
    return this.subscriptionClient.getCoreChainLockedHeight();
  }

  /**
   * Whether a JSON-RPC endpoint is configured: only a custom devnet with its
   * own rpcUrl. Every other network reads Platform status instead.
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
   * block height + timestamp). Used by the network-health indicator on
   * testnet and devnets; see DAPISubscriptionClient.getPlatformStatus.
   */
  async getPlatformStatus(): Promise<PlatformStatus> {
    return this.subscriptionClient.getPlatformStatus();
  }

  /**
   * Platform status for background polling: `undefined` means "not read yet"
   * (testnet and mainnet, before a funding flow started connecting the EvoSDK, or while
   * that connect is in flight), which is not a failure. A failing read after
   * that rejects. See DAPISubscriptionClient.peekPlatformStatus.
   */
  async peekPlatformStatus(): Promise<PlatformStatus | undefined> {
    return this.subscriptionClient.peekPlatformStatus();
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

  /**
   * Start finding testnet or mainnet evonodes for the IS lock subscription. Never
   * rejects; a no-op on networks with configured addresses or JSON-RPC.
   */
  warmEvonodeDiscovery(): Promise<void> {
    if (this.hasJsonRpc) return Promise.resolve();
    return this.subscriptionClient.warmEvonodeDiscovery();
  }

  /**
   * Open the DAPI subscription, retrying while nothing has been broadcast:
   * evonodes can be briefly unreachable, and failing here would leave the
   * user with an unspent deposit and no in-app way back to it. The final
   * failure says so.
   */
  private async subscribeBeforeBroadcast(
    txid: string,
    publicKey: Uint8Array,
    utxo: { txid: string; vout: number },
    timeoutMs: number,
    onProgress?: (message: string) => void
  ): Promise<{ wait: () => Promise<Uint8Array> }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.subscriptionClient.subscribeForInstantSendLock(
          txid, publicKey, utxo, timeoutMs, onProgress
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.lifetime.signal.aborted || /aborted/i.test(message)) throw error;
        const delay = PRE_BROADCAST_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          throw new Error(
            `${message}. Nothing was broadcast, so your deposit has not been spent; ` +
              'it can be recovered with the key backup that was downloaded.'
          );
        }
        console.warn(`[islock] subscription failed before broadcast, retrying in ${delay} ms:`, error);
        onProgress?.('Could not reach Dash evonodes, retrying...');
        await abortableSleep(delay, this.lifetime.signal);
        if (this.lifetime.signal.aborted) {
          throw new Error(`InstantSend lock subscription aborted for ${txid}`);
        }
      }
    }
  }

  async disconnect(): Promise<void> {
    this.lifetime.abort();
    await this.subscriptionClient.disconnect();
  }
}
