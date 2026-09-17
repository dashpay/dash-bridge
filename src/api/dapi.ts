/** Optional JSON-RPC fast path for retrieving InstantSend locks by txid. */
import { MAINNET, TESTNET } from '../config.js';
import { fetchJson } from '../utils/fetch-json.js';
import type { RetryOptions } from '../utils/retry.js';
import { describeIslock } from '../utils/islock-debug.js';
import { abortableSleep } from '../utils/sleep.js';

export interface DAPIConfig {
  network: string;
  rpcUrl?: string;
}

const REQUEST_TIMEOUT_MS = 8000;

export class DAPIClient {
  readonly network: string;
  private readonly rpcUrl?: string;

  constructor(config: DAPIConfig) {
    this.network = config.network;
    this.rpcUrl = config.rpcUrl ?? (config.network === 'mainnet'
      ? MAINNET.rpcUrl : config.network === 'testnet' ? TESTNET.rpcUrl : undefined);
  }

  get hasRpcUrl(): boolean {
    return !!this.rpcUrl;
  }

  private async request(
    method: string,
    params: unknown[],
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (!this.rpcUrl) throw new Error(`No RPC URL configured for network ${this.network}`);
    const data = await fetchJson(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal,
    }, timeoutMs);
    if (!data || typeof data !== 'object') throw new Error(`Invalid RPC ${method} response`);
    if (data.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(data.error)}`);
    if (!('result' in data)) throw new Error(`RPC ${method} response missing result`);
    return data.result;
  }

  async waitForInstantSendLock(
    txid: string,
    timeoutMs = 60000,
    onRetry?: RetryOptions['onRetry'],
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    let failures = 0;
    while (Date.now() < deadline && !signal?.aborted) {
      try {
        const result = await this.request('getislocks', [[txid]], Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()), signal);
        if (!Array.isArray(result)) throw new Error('Invalid getislocks response');
        const lock = result.find((item) => item?.txid === txid);
        if (lock) {
          if (typeof lock.hex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(lock.hex)) {
            throw new Error('Invalid InstantSend lock hex');
          }
          const bytes = Uint8Array.from(lock.hex.match(/../g)!, (pair: string) => parseInt(pair, 16));
          const debug = describeIslock(bytes, 'json-rpc');
          if (debug.parsed?.txid !== txid) throw new Error('Invalid or mismatched InstantSend lock');
          return bytes;
        }
        failures = 0;
      } catch (error) {
        if (signal?.aborted) break;
        failures++;
        onRetry?.(failures, 3, error);
        // An unreachable/blocked provider should yield to the chain-proof path
        // promptly. Empty results still poll until the normal IS lock deadline.
        if (failures >= 3) throw error;
      }
      if (Date.now() >= deadline) break;
      await abortableSleep(Math.min(2000 * 2 ** failures, 10000, Math.max(0, deadline - Date.now())), signal);
    }
    throw new Error(signal?.aborted
      ? `InstantSend lock polling aborted for ${txid}`
      : `Timeout waiting for InstantSend lock for ${txid} after ${timeoutMs}ms`);
  }

  /** Core-only health backup; this does not establish Platform readiness. */
  async getBestChainLock(): Promise<{ height: number; blockhash?: string } | null> {
    if (!this.hasRpcUrl) return null;
    const result = await this.request('getbestchainlock', []);
    if (result === null) return null;
    const lock = result as { height?: number; blockhash?: string };
    if (typeof lock?.height !== 'number' || !Number.isSafeInteger(lock.height) || lock.height < 0) {
      throw new Error('Invalid chain-lock height');
    }
    return { height: lock.height, blockhash: lock.blockhash };
  }
}
