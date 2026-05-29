import type { UTXO, TxInfo } from '../types.js';
import type { NetworkConfig } from '../config.js';
import { withRetry, type RetryOptions } from '../utils/retry.js';
import { abortableSleep } from '../utils/sleep.js';

export interface InsightApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

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
      const response = await fetch(`${this.baseUrl}/addr/${address}/utxo`);

      if (!response.ok) {
        throw new Error(`Insight API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

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
   * Current Core block height, via Insight `/status?q=getInfo` (`info.blocks`).
   * Used by the network-status indicator to compare Core's tip against
   * Platform's chain-locked height.
   */
  async getBlockHeight(retryOptions?: RetryOptions): Promise<number> {
    return withRetry(async () => {
      const response = await fetch(`${this.baseUrl}/status?q=getInfo`);

      if (!response.ok) {
        throw new Error(`Insight API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
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
      const response = await fetch(`${this.baseUrl}/tx/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rawtx: txHex }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Broadcast failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      return result.txid;
    }, retryOptions);
  }

  /**
   * Get transaction details
   */
  async getTransaction(txid: string, retryOptions?: RetryOptions): Promise<TxInfo> {
    return withRetry(async () => {
      const response = await fetch(`${this.baseUrl}/tx/${txid}`);

      if (!response.ok) {
        throw new Error(`Failed to get transaction: ${response.status}`);
      }

      const data = await response.json();

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
        const info = await this.getTransaction(txid);
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
