import {
  isPlatformSdkSettled,
  withConnectedPlatformSdk,
  withPlatformOperationTimeout,
} from './client.js';

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
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/**
 * Like {@link fetchPlatformStatus}, but never starts the SDK download: resolves
 * `undefined` ("not read yet", not a failure) while nothing has started
 * connecting the SDK, or while that first connect is still in flight. For
 * background health polling, which must not pull the ~7 MB (gzip) SDK onto
 * every page load just to draw an indicator.
 *
 * Once a connect has been attempted, reads always go through it, and a failing
 * read rejects: after a connection error the SDK is evicted from the cache, and
 * the next poll reconnects (the module is already loaded) rather than falling
 * back to "not read yet", so a Platform outage shows as degraded and a recovery
 * shows as healthy again.
 */
export async function fetchPlatformStatusIfSdkReady(
  network: string
): Promise<PlatformStatus | undefined> {
  return isPlatformSdkSettled(network) ? fetchPlatformStatus(network) : undefined;
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
        // wasm getters build a new object per access, so read `chain` once.
        const chain = status?.chain;
        return {
          coreChainLockedHeight: positiveInteger(chain?.core_chain_locked_height),
          latestBlockHeight: positiveInteger(chain?.latest_block_height),
          latestBlockTimeMs: positiveInteger(status?.time?.block),
        };
      },
      { maxAttempts: 1 }
    ),
    'reading Platform status',
    PLATFORM_STATUS_TIMEOUT_MS
  );
}
