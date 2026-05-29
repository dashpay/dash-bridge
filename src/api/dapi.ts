/**
 * Client for InstantSend lock retrieval via JSON-RPC API
 */

import { withRetry, type RetryOptions } from '../utils/retry.js';
import { describeIslock } from '../utils/islock-debug.js';
import { abortableSleep } from '../utils/sleep.js';

const API_URLS: Record<string, string> = {
  testnet: 'https://trpc.digitalcash.dev',
  mainnet: 'https://rpc.digitalcash.dev',
};

export interface DAPIConfig {
  network: string;
  rpcUrl?: string;
}

/**
 * Response from the getislocks JSON-RPC endpoint
 */
interface IslockResponse {
  result?: Array<{
    txid: string;
    hex: string; // hex-encoded islock bytes
    signature?: string;
    cycleHash?: string;
  }>;
  error?: unknown;
  id?: unknown;
}

interface BestChainLockResponse {
  result?: {
    height?: number;
    blockhash?: string;
    signature?: string;
    known_block?: boolean;
  };
  error?: unknown;
  id?: unknown;
}

/**
 * Client for InstantSend lock retrieval
 */
export class DAPIClient {
  readonly network: string;
  private readonly rpcUrl?: string;

  constructor(config: DAPIConfig) {
    this.network = config.network;
    this.rpcUrl = config.rpcUrl;
  }

  get hasRpcUrl(): boolean {
    return !!(this.rpcUrl || API_URLS[this.network]);
  }

  /**
   * Broadcast a transaction via DAPI
   *
   * Note: This is a placeholder. Use InsightClient.broadcastTransaction instead.
   */
  async broadcastTransaction(_txBytes: Uint8Array): Promise<string> {
    throw new Error(
      'DAPI broadcastTransaction not implemented. Use InsightClient.broadcastTransaction instead.'
    );
  }

  /**
   * Get InstantSend lock from tRPC API
   * Polls the API until the islock is available or timeout is reached
   * @param onRetry - Optional callback when a network error causes a retry
   * @param signal - Optional AbortSignal to cancel polling early
   */
  async waitForInstantSendLock(
    txid: string,
    timeoutMs: number = 60000,
    onRetry?: (attempt: number, maxAttempts: number, error: unknown) => void,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const startTime = Date.now();
    const pollInterval = 2000; // Poll every 2 seconds

    while (Date.now() - startTime < timeoutMs) {
      if (signal?.aborted) {
        throw new Error(`InstantSend lock polling aborted for ${txid}`);
      }
      try {
        const islock = await this.getIslock(txid, { onRetry });
        if (islock) {
          return islock;
        }
      } catch (error) {
        console.warn('Error polling for islock:', error);
      }

      // Wait before next poll, but bail out immediately if aborted
      await abortableSleep(pollInterval, signal);
    }

    throw new Error(
      `Timeout waiting for InstantSend lock for ${txid} after ${timeoutMs}ms`
    );
  }

  /**
   * Fetch the current best chain-locked height via JSON-RPC.
   * Returns null if no chain lock has been observed yet.
   */
  async getBestChainLock(retryOptions?: RetryOptions): Promise<{ height: number; blockhash?: string } | null> {
    if (!this.hasRpcUrl) {
      return null;
    }

    return withRetry(async () => {
      const baseUrl = this.rpcUrl ?? API_URLS[this.network];
      if (!baseUrl) {
        return null;
      }

      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'getbestchainlock', params: [] }),
      });

      if (!response.ok) {
        throw new Error(`RPC API error: ${response.status} ${response.statusText}`);
      }

      const data: BestChainLockResponse = await response.json();
      if (!data.result || typeof data.result.height !== 'number') {
        return null;
      }
      return { height: data.result.height, blockhash: data.result.blockhash };
    }, retryOptions);
  }

  /**
   * Fetch islock from JSON-RPC API
   */
  private async getIslock(txid: string, retryOptions?: RetryOptions): Promise<Uint8Array | null> {
    return withRetry(async () => {
      const baseUrl = this.rpcUrl ?? API_URLS[this.network];
      if (!baseUrl) {
        throw new Error(`No RPC URL configured for network ${this.network}`);
      }

      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          method: 'getislocks',
          params: [[txid]],
        }),
      });

      if (!response.ok) {
        throw new Error(`RPC API error: ${response.status} ${response.statusText}`);
      }

      const data: IslockResponse = await response.json();

      // Check if we got a result
      if (data.result && data.result.length > 0) {
        const islockData = data.result.find((item) => item.txid === txid);
        if (islockData?.hex) {
          const bytes = hexToBytes(islockData.hex);
          const debug = describeIslock(bytes, `json-rpc:${baseUrl}`);
          console.log('[islock-debug] IS lock received via JSON-RPC:', debug);
          if (islockData.signature || islockData.cycleHash) {
            console.log('[islock-debug] JSON-RPC reported fields:', {
              signature: islockData.signature,
              cycleHash: islockData.cycleHash,
            });
          }
          return bytes;
        }
      }

      return null;
    }, retryOptions);
  }
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

