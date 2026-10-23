import { withConnectedPlatformSdk, withPlatformOperationTimeout } from './client.js';

export interface PlatformStatus {
  coreChainLockedHeight?: number;
  latestBlockHeight?: number;
  /** Latest Platform block time, Unix milliseconds. */
  latestBlockTimeMs?: number;
}

const PLATFORM_STATUS_TIMEOUT_MS = 20000;

/**
 * The SDK types these as number/string, but wasm bindings can surface u64
 * fields as bigint and proto3 omits zero values, so accept number, bigint and
 * numeric strings and treat anything that is not a positive safe integer as
 * "not reported".
 */
function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'string') {
    return undefined;
  }
  if (value === '') return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/**
 * Read Platform status through the EvoSDK (`sdk.system.status()`).
 *
 * Used instead of `@dashevo/dapi-client`'s `platform.getStatus()` on testnet:
 * testnet evonodes omit the optional `state_sync` message (and occasionally
 * a version sub-field), and dapi-client 3.1.0-dev.7's
 * `GetStatusResponse.createFromProto` dereferences them unconditionally, so
 * the whole call throws even though the chain/time data is present. The SDK
 * decodes the same response tolerantly.
 *
 * Fields the node does not report are `undefined`.
 */
export async function fetchPlatformStatus(network: string): Promise<PlatformStatus> {
  return withPlatformOperationTimeout(
    withConnectedPlatformSdk(
      network,
      async (sdk) => {
        const status = await sdk.system.status();
        return {
          coreChainLockedHeight: positiveInteger(status?.chain?.core_chain_locked_height),
          latestBlockHeight: positiveInteger(status?.chain?.latest_block_height),
          latestBlockTimeMs: positiveInteger(status?.time?.block),
        };
      },
      { maxAttempts: 1 }
    ),
    'reading Platform status',
    PLATFORM_STATUS_TIMEOUT_MS
  );
}
