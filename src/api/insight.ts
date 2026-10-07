import type { AuthenticatedUtxo, UTXO, TxInfo } from '../types.js';
import type { NetworkConfig } from '../config.js';
import { withRetry, isRetryableError, type RetryOptions } from '../utils/retry.js';
import { abortableSleep } from '../utils/sleep.js';
import { hexToBytes } from '../utils/hex.js';
import {
  assertTxid,
  authenticateUtxo,
  UtxoAuthenticationError,
} from '../transaction/utxo-auth.js';
import { fetchJson } from '../utils/fetch-json.js';
import { fetchWithDeadline, RequestTimeoutError } from '../utils/fetch-with-deadline.js';

/**
 * Broadcast POSTs get a longer deadline than reads. A timed-out broadcast may
 * be retried by withRetry; re-sending the same signed tx is harmless while it
 * is unconfirmed, but a retry after it was mined is rejected with
 * "already in block chain" (see isAmbiguousBroadcastError).
 */
const BROADCAST_TIMEOUT_MS = 20000;

/**
 * Whether a broadcast error leaves the outcome unknown rather than failed:
 * a timeout may have reached the node, and "already in block chain" means an
 * earlier timed-out attempt of the same signed tx was mined.
 */
export function isAmbiguousBroadcastError(error: unknown): boolean {
  if (error instanceof RequestTimeoutError) return true;
  return error instanceof Error && error.message.includes('already in block chain');
}

export interface InsightApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * `/rawtx` returned 404. The address index can list a fresh deposit before
 * `/rawtx` serves it (e.g. another backend node), so this is retried longer
 * than other errors, and its message is what the user sees if it persists.
 */
class RawTxNotIndexedError extends Error {
  constructor() {
    super('The explorer has not indexed your deposit transaction yet. Wait a moment and use Check Again.');
    this.name = 'RawTxNotIndexedError';
  }
}

/**
 * Retry schedule for `/rawtx`: 6 attempts with 1s, 2s, then 4s backoff
 * (plus up to 50% jitter) gives roughly 15-22s for the explorer to catch up.
 */
const RAWTX_RETRY: RetryOptions = {
  maxAttempts: 6,
  baseDelayMs: 1000,
  maxDelayMs: 4000,
  shouldRetry: (error) => error instanceof RawTxNotIndexedError || isRetryableError(error),
};

/**
 * Insight API client for UTXO lookup and transaction broadcast
 */
export class InsightClient {
  constructor(private readonly config: NetworkConfig) {}

  private get baseUrl(): string {
    return this.config.insightApiUrl;
  }

  /**
   * Get UTXOs for an address
   */
  async getUTXOs(address: string, retryOptions?: RetryOptions): Promise<UTXO[]> {
    return withRetry(async () => {
      const data = await fetchJson(`${this.baseUrl}/addr/${address}/utxo`);

      // Map Insight API response to our UTXO type
      return data.map((utxo: Record<string, unknown>) => ({
        txid: utxo.txid as string,
        vout: utxo.vout as number,
        satoshis: utxo.satoshis as number,
        scriptPubKey: utxo.scriptPubKey as string,
        confirmations: utxo.confirmations as number,
      }));
    }, retryOptions);
  }

  /**
   * Fetch the raw serialized bytes of a transaction via `/rawtx/{txid}`.
   * The bytes are NOT trusted here; see {@link getAuthenticatedUtxo}.
   */
  async getRawTransaction(txid: string, retryOptions?: RetryOptions): Promise<Uint8Array> {
    assertTxid(txid);
    const rawtx = await withRetry(async () => {
      const response = await fetch(`${this.baseUrl}/rawtx/${txid}`);

      if (response.status === 404) {
        throw new RawTxNotIndexedError();
      }
      if (!response.ok) {
        throw new Error(`Insight API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json().catch(() => {
        throw new Error('Insight returned a non-JSON raw transaction response');
      });
      return data?.rawtx;
    }, { ...RAWTX_RETRY, ...retryOptions });

    if (typeof rawtx !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(rawtx)) {
      throw new UtxoAuthenticationError('Explorer returned a malformed raw transaction');
    }
    return hexToBytes(rawtx);
  }

  /**
   * The single trust boundary for funding UTXOs: fetch the raw previous
   * transaction and return the UTXO with the value and script it actually
   * commits to. Every flow that builds and signs from an Insight UTXO must
   * pass it through here first. Throws if Insight's report disagrees.
   */
  async getAuthenticatedUtxo(
    utxo: UTXO,
    depositPublicKey: Uint8Array,
    retryOptions?: RetryOptions
  ): Promise<AuthenticatedUtxo> {
    const rawTx = await this.getRawTransaction(utxo.txid, retryOptions);
    return authenticateUtxo(utxo, rawTx, depositPublicKey);
  }

  /**
   * Current Core block height, via Insight `/status?q=getInfo` (`info.blocks`).
   * Used by the network-status indicator to compare Core's tip against
   * Platform's chain-locked height.
   */
  async getBlockHeight(retryOptions?: RetryOptions): Promise<number> {
    return withRetry(async () => {
      const data = await fetchJson(`${this.baseUrl}/status?q=getInfo`);
      const blocks = data?.info?.blocks;
      if (typeof blocks !== 'number') {
        throw new Error('Insight getInfo response missing info.blocks');
      }
      return blocks;
    }, retryOptions);
  }

  /**
   * Broadcast a raw transaction
   */
  async broadcastTransaction(txHex: string, retryOptions?: RetryOptions): Promise<string> {
    return withRetry(async () => {
      const result = await fetchWithDeadline(
        `${this.baseUrl}/tx/send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ rawtx: txHex }),
        },
        BROADCAST_TIMEOUT_MS,
        async (response) => {
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Broadcast failed: ${response.status} - ${errorText}`);
          }
          return response.json();
        }
      );
      return result.txid;
    }, retryOptions);
  }

  /**
   * Get transaction details
   */
  async getTransaction(txid: string, retryOptions?: RetryOptions, signal?: AbortSignal): Promise<TxInfo> {
    return withRetry(async () => {
      const data = await fetchJson(`${this.baseUrl}/tx/${txid}`, { signal });

      // Insight returns blockheight: -1 while the tx is unconfirmed.
      const rawHeight =
        typeof data.blockheight === 'number' ? data.blockheight : undefined;
      const blockheight =
        rawHeight !== undefined && rawHeight >= 0 ? rawHeight : undefined;

      return {
        txid: data.txid,
        confirmations: data.confirmations || 0,
        txlock: data.txlock || false,
        blockheight,
      };
    }, retryOptions);
  }

  /**
   * Poll until the tx is mined into a block and Insight reports a block
   * height. Resolves with the block height. Aborts when `signal` fires.
   *
   * @param onPoll - Optional callback invoked on each poll with the latest
   *   TxInfo, so the caller can drive UI progress.
   */
  async waitForBlockHeight(
    txid: string,
    pollIntervalMs: number = 5000,
    signal?: AbortSignal,
    onPoll?: (info: TxInfo) => void
  ): Promise<number> {
    while (!signal?.aborted) {
      try {
        // Don't burn backoff retries on a request the caller cancelled.
        const info = await this.getTransaction(
          txid,
          { shouldRetry: (error) => !signal?.aborted && isRetryableError(error) },
          signal
        );
        onPoll?.(info);
        if (info.blockheight !== undefined) {
          return info.blockheight;
        }
      } catch (error) {
        // Tx may not be in the mempool yet, or transient API error — keep polling.
        console.warn('waitForBlockHeight: polling error', error);
      }

      await abortableSleep(pollIntervalMs, signal);
    }

    throw new Error(`Block-height polling aborted for ${txid}`);
  }

  /**
   * Result from waitForUtxo - includes info about insufficient deposits
   */


  /**
   * Poll for UTXOs until one appears or timeout
   * @param onProgress - Optional callback with (remainingMs, currentTotal) on each poll
   * @param onRetry - Optional callback when a network error causes a retry
   * @returns Object with utxo (if sufficient), totalAmount, and timedOut status
   */
  async waitForUtxo(
    address: string,
    minAmount: number,
    timeoutMs: number = 120000, // 2 minutes
    pollIntervalMs: number = 3000,
    onProgress?: (remainingMs: number, currentTotal: number) => void,
    onRetry?: (attempt: number, maxAttempts: number, error: unknown) => void
  ): Promise<{ utxo: UTXO | null; totalAmount: number; timedOut: boolean }> {
    const startTime = Date.now();
    let lastTotalAmount = 0;

    while (Date.now() - startTime < timeoutMs) {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, timeoutMs - elapsed);

      try {
        const utxos = await this.getUTXOs(address, { onRetry });

        // Calculate total amount across all UTXOs
        const totalAmount = utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0);
        lastTotalAmount = totalAmount;

        // Call progress callback with remaining time and current total
        if (onProgress) {
          onProgress(remaining, totalAmount);
        }

        // Find the largest UTXO that meets minimum (or sum could work too)
        // For simplicity, check if total meets minimum and use largest UTXO
        if (totalAmount >= minAmount) {
          const largest = utxos.reduce((max, utxo) =>
            utxo.satoshis > max.satoshis ? utxo : max
          , utxos[0]);
          return { utxo: largest, totalAmount, timedOut: false };
        }
      } catch (error) {
        // Log error but continue polling - transient errors shouldn't stop the wait
        console.warn('Error polling for UTXOs:', error);
        // Still call progress with last known amount
        if (onProgress) {
          onProgress(remaining, lastTotalAmount);
        }
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Final check on timeout (with retry)
    try {
      const utxos = await this.getUTXOs(address, { onRetry });
      const totalAmount = utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0);
      return { utxo: null, totalAmount, timedOut: true };
    } catch {
      // If final check fails, return last known amount
      return { utxo: null, totalAmount: lastTotalAmount, timedOut: true };
    }
  }

  /**
   * Poll for transaction lock or confirmation
   */
  async waitForConfirmation(
    txid: string,
    timeoutMs: number = 60000,
    pollIntervalMs: number = 2000
  ): Promise<TxInfo> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const tx = await this.getTransaction(txid);

        if (tx.confirmations > 0 || tx.txlock) {
          return tx;
        }
      } catch {
        // Transaction might not be in mempool yet
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error('Timeout waiting for transaction confirmation');
  }
}
