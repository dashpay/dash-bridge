import { withConnectedPlatformSdk, withPlatformOperationTimeout } from './client.js';

export interface PlatformStatus {
  coreChainLockedHeight?: number;
  latestBlockHeight?: number;
  latestBlockTimeMs?: number;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** Public networks use the same quorum discovery and node rotation as writes. */
export async function fetchPlatformStatus(network: string): Promise<PlatformStatus> {
  return withPlatformOperationTimeout(
    withConnectedPlatformSdk(network, async (sdk) => {
      const status = await sdk.system.status();
      return {
        coreChainLockedHeight: positiveInteger(status.chain.core_chain_locked_height),
        latestBlockHeight: positiveInteger(status.chain.latest_block_height),
        latestBlockTimeMs: positiveInteger(status.time.block),
      };
    }, { maxAttempts: 1 }),
    'reading Platform status',
    20000
  );
}
