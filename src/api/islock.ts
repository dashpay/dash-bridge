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

  async waitForInstantSendLock(
    txid: string,
    publicKey: Uint8Array,
    utxo: { txid: string; vout: number },
    timeoutMs: number = 60000,
    onRetry?: RetryOptions['onRetry']
  ): Promise<Uint8Array> {
    if (!this.hasJsonRpc) {
      return this.subscriptionClient.waitForInstantSendLock(txid, publicKey, utxo, timeoutMs);
    }

    // Race JSON-RPC polling against DAPI subscription — first success wins
    const jsonRpcPromise = this.jsonRpcClient.waitForInstantSendLock(txid, timeoutMs, onRetry);
    const dapiPromise = this.subscriptionClient.waitForInstantSendLock(txid, publicKey, utxo, timeoutMs);

    try {
      return await Promise.any([jsonRpcPromise, dapiPromise]);
    } catch (error) {
      if (error instanceof AggregateError) {
        throw new Error(
          `All IS lock sources failed: ${error.errors.map((e) => (e as Error).message).join('; ')}`
        );
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.subscriptionClient.disconnect();
  }
}
