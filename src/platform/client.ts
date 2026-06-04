import type { EvoSDK } from '@dashevo/evo-sdk';
import { withRetry, type RetryOptions } from '../utils/retry.js';
import { devnetNameForSdk, getNetwork } from '../config.js';
import { loadSdkModule } from './sdkModule.js';

export type PlatformNetwork = string;

export interface PlatformIdentityKeyRecord {
  keyId: number;
  keyType?: string;
  purpose?: string;
  securityLevel?: string;
  data?: unknown;
  disabledAt?: unknown;
}

const PLATFORM_REQUEST_SETTINGS = {
  connectTimeoutMs: 10000,
  // wait_for_state_transition_result uses a 30s server-side wait window,
  // so client-side request timeout must exceed that on runtimes that honor it.
  timeoutMs: 40000,
  retries: 2,
  banFailedAddress: true,
} as const;

export const PLATFORM_PUT_SETTINGS = {
  ...PLATFORM_REQUEST_SETTINGS,
} as const;

const PLATFORM_OPERATION_TIMEOUT_MS = 45000;

const sdkCache = new Map<string, EvoSDK>();

async function createPlatformSdk(network: PlatformNetwork): Promise<EvoSDK> {
  const { EvoSDK } = await loadSdkModule();
  const options = { settings: PLATFORM_REQUEST_SETTINGS };
  const config = getNetwork(network);

  if (config.type === 'mainnet') {
    return EvoSDK.mainnetTrusted(options);
  }

  if (config.type === 'devnet') {
    const devnetName = devnetNameForSdk(config.name);

    if (config.useTrustedContext) {
      // Trusted devnet mode (SDK >= 3.1.0-dev.7): the SDK prefetches a
      // devnet-specific quorum context, which provides both the quorum keys
      // for proof verification and the masternode address list. When
      // `trustedQuorumUrl` is omitted the SDK defaults to
      // `https://quorums.<devnetName>.networks.dash.org`.
      return EvoSDK.devnetTrusted(devnetName, {
        quorumUrl: config.trustedQuorumUrl,
        ...options,
      });
    }

    if (!config.dapiAddresses?.length) {
      throw new Error(
        `Devnet "${config.name}" is missing dapiAddresses; non-trusted ` +
          `devnet mode requires explicit addresses`
      );
    }

    // Non-trusted devnet mode: explicit addresses, no quorum context, so
    // proof-bearing queries fail (use *Unproved variants and polling — see
    // waitForIdentityByPolling). For the chainlock fallback we read
    // core_chain_locked_height via @dashevo/dapi-client.platform.getStatus()
    // directly against the devnet's dapiAddresses — see
    // DAPISubscriptionClient.getCoreChainLockedHeight in api/dapi-subscription.ts.
    return EvoSDK.devnet(devnetName, {
      addresses: config.dapiAddresses,
      ...options,
    });
  }

  return EvoSDK.testnetTrusted(options);
}

export async function connectPlatformSdk(
  network: PlatformNetwork,
  retryOptions?: RetryOptions
): Promise<EvoSDK> {
  const cached = sdkCache.get(network);
  if (cached && cached.isConnected) {
    return cached;
  }

  const sdk = await createPlatformSdk(network);

  console.log(`Connecting to ${network}...`);
  await withRetry(() => sdk.connect(), retryOptions);
  console.log('Connected to Platform');

  sdkCache.set(network, sdk);
  return sdk;
}

export function disconnectPlatformSdk(network: PlatformNetwork): void {
  sdkCache.delete(network);
}

function isConnectionError(error: unknown): boolean {
  if (!(error && typeof error === 'object' && 'message' in error)) {
    return false;
  }
  const msg = String((error as { message: unknown }).message).toLowerCase();
  return (
    msg.includes('transport') ||
    msg.includes('connection') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('network') ||
    msg.includes('unavailable') ||
    msg.includes('failed to fetch')
  );
}

export async function withConnectedPlatformSdk<T>(
  network: PlatformNetwork,
  callback: (sdk: EvoSDK) => Promise<T>,
  retryOptions?: RetryOptions
): Promise<T> {
  const sdk = await connectPlatformSdk(network, retryOptions);
  try {
    return await callback(sdk);
  } catch (error) {
    if (isConnectionError(error)) {
      disconnectPlatformSdk(network);
    }
    throw error;
  }
}

export async function withPlatformOperationTimeout<T>(
  promise: Promise<T>,
  action: string,
  timeoutMs: number = PLATFORM_OPERATION_TIMEOUT_MS
): Promise<T> {
  let timeoutId: number | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(`Timed out while ${action}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

export async function fetchIdentityWithSdk(
  sdk: EvoSDK,
  identityId: string,
  retryOptions?: RetryOptions
) {
  return withRetry(() => sdk.identities.fetch(identityId), retryOptions);
}

/**
 * Fetch an identity WITHOUT proof verification (`prove: false`). Required on
 * non-trusted devnets, where the SDK has no quorum context, so any
 * proof-verifying read would fail. On trusted devnets (and mainnet/testnet)
 * the regular `fetchIdentityWithSdk` is preferred.
 */
export async function fetchIdentityUnprovedWithSdk(
  sdk: EvoSDK,
  identityId: string
) {
  return sdk.identities.fetchUnproved(identityId);
}

/**
 * Poll `fetchUnproved(identityId)` until the identity exists on Platform or
 * the deadline expires. Used as a fallback after a "broadcast-only" identity
 * registration on non-trusted devnets, where `sdk.identities.create()` cannot
 * complete its proof-verifying wait phase.
 */
export async function waitForIdentityByPolling(
  sdk: EvoSDK,
  identityId: string,
  timeoutMs: number,
  intervalMs: number = 2000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const identity = await sdk.identities.fetchUnproved(identityId);
      if (identity) return true;
    } catch {
      // Not found yet (or transient transport error) — keep polling.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export async function fetchIdentity(
  identityId: string,
  network: PlatformNetwork,
  retryOptions?: RetryOptions
) {
  return withConnectedPlatformSdk(
    network,
    (sdk) => fetchIdentityWithSdk(sdk, identityId, retryOptions),
    retryOptions
  );
}

export async function getIdentityBalanceAndRevisionWithSdk(
  sdk: EvoSDK,
  identityId: string,
  retryOptions?: RetryOptions
): Promise<{ balance: number; revision: number }> {
  const result = await withRetry(
    () => sdk.identities.balanceAndRevision(identityId),
    retryOptions
  );

  return {
    balance: Number(result?.balance ?? 0n),
    revision: Number(result?.revision ?? 0n),
  };
}

export async function getIdentityBalanceAndRevision(
  identityId: string,
  network: PlatformNetwork,
  retryOptions?: RetryOptions
): Promise<{ balance: number; revision: number }> {
  return withConnectedPlatformSdk(
    network,
    (sdk) => getIdentityBalanceAndRevisionWithSdk(sdk, identityId, retryOptions),
    retryOptions
  );
}

export async function fetchIdentityPublicKeyRecordsWithSdk(
  sdk: EvoSDK,
  identityId: string,
  retryOptions?: RetryOptions
): Promise<PlatformIdentityKeyRecord[]> {
  const keysResponse = await withRetry(
    () => sdk.identities.getKeys({
      identityId,
      request: { type: 'all' },
    }),
    retryOptions
  );

  if (!keysResponse) {
    throw new Error('Identity not found');
  }

  const keysArray = Array.isArray(keysResponse) ? keysResponse : [keysResponse];
  if (keysArray.length === 0) {
    throw new Error('Identity has no keys');
  }

  return keysArray as PlatformIdentityKeyRecord[];
}

export async function fetchIdentityPublicKeyRecords(
  identityId: string,
  network: PlatformNetwork,
  retryOptions?: RetryOptions
): Promise<PlatformIdentityKeyRecord[]> {
  return withConnectedPlatformSdk(
    network,
    (sdk) => fetchIdentityPublicKeyRecordsWithSdk(sdk, identityId, retryOptions),
    retryOptions
  );
}
