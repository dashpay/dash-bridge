declare module '@dashevo/dapi-client' {
  interface DAPIClientOptions {
    network?: 'testnet' | 'mainnet';
    timeout?: number;
    retries?: number;
    dapiAddresses?: string[];
    seeds?: string[];
  }

  interface BloomFilterParams {
    vData: Uint8Array;
    nHashFuncs: number;
    nTweak: number;
    nFlags: number;
  }

  interface SubscribeOptions {
    fromBlockHeight?: number;
    fromBlockHash?: string;
    count?: number;
    sendTransactionHashes?: boolean;
  }

  interface StreamResponse {
    on(event: 'data', callback: (data: unknown) => void): void;
    on(event: 'error', callback: (error: Error) => void): void;
    on(event: 'end', callback: () => void): void;
    cancel(): void;
  }

  interface CoreMethods {
    getBestBlockHeight(): Promise<number>;
    broadcastTransaction(transaction: Buffer | Uint8Array): Promise<string>;
    getTransaction(txid: string): Promise<Buffer>;
    subscribeToTransactionsWithProofs(
      bloomFilter: BloomFilterParams,
      options?: SubscribeOptions
    ): Promise<StreamResponse>;
  }

  class DAPIClient {
    constructor(options?: DAPIClientOptions);
    core: CoreMethods;
    disconnect(): Promise<void>;
  }

  export = DAPIClient;
}

declare module '@dashevo/dashcore-lib' {
  interface BloomFilterInstance {
    vData: number[];
    nHashFuncs: number;
    nTweak: number;
    nFlags: number;
    insert(data: Uint8Array | Buffer): void;
    contains(data: Uint8Array | Buffer): boolean;
  }

  interface BloomFilterStatic {
    create(
      elements: number,
      falsePositiveRate: number,
      nTweak: number,
      nFlags: number
    ): BloomFilterInstance;
    BLOOM_UPDATE_ALL: number;
    BLOOM_UPDATE_NONE: number;
    BLOOM_UPDATE_P2PUBKEY_ONLY: number;
  }

  interface InstantLockInstance {
    txid: string;
    inputs: Array<{ outpointHash: string; outpointIndex: number }>;
    signature: string;
    version?: number;
    cyclehash?: string;
    toBuffer(): Buffer;
    toObject(): object;
  }

  interface InstantLockStatic {
    fromBuffer(buffer: Buffer): InstantLockInstance;
    fromHex(hex: string): InstantLockInstance;
    fromObject(obj: object): InstantLockInstance;
  }

  const BloomFilter: BloomFilterStatic;
  const InstantLock: InstantLockStatic;

  export { BloomFilter, InstantLock };
}
